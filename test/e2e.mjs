/**
 * End-to-end smoke test: launches real Chrome with the built extension loaded,
 * points it at a mock OpenAI server, types into a fixture page, and checks that
 * ghost text appears and Tab accepts it.
 *
 * The mock server records the prompt it was sent, so this also proves what the
 * extension actually derived from the page.
 *
 *   node test/e2e.mjs [--headed]
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(root, "dist");
const HEADED = process.argv.includes("--headed");
const PORT = 8123;
const CDP_PORT = 9333;

const SUGGESTION = " confirm whether all three printers are on build 3.2.0.4711?";

/**
 * By default everything points at the mock so the assertions are exact. Set
 * CARAT_API_KEY (and optionally CARAT_MODEL) to run the same script against the
 * real OpenAI API instead - the completion-text assertions relax accordingly.
 */
const LIVE = Boolean(process.env.CARAT_API_KEY);
const API_KEY = process.env.CARAT_API_KEY ?? "mock-key";
const MODEL = process.env.CARAT_MODEL ?? (LIVE ? "gpt-5.6-luna" : "mock-model");
const BASE_URL = LIVE ? "https://api.openai.com/v1" : `http://127.0.0.1:${PORT}/v1`;
/** CARAT_NO_CDP=1 runs everything through the DOM fallback instead of the AX tree. */
const NO_CDP = Boolean(process.env.CARAT_NO_CDP);

let lastPrompt = null;
let requestCount = 0;
const textPrompts = [];
const predictPrompts = [];

/**
 * The mock's idea of what comes next. Text: the canned suggestion, then
 * nothing once it has been accepted (the thought is finished). Actions: send
 * the reply - until the history shows it has been sent.
 */
function mockReply(parsed) {
  const isPredict = /next action/.test(parsed.instructions ?? "");
  const prompt = parsed.input?.[0]?.content?.[0]?.text ?? parsed.messages?.at(-1)?.content ?? "";
  lastPrompt = prompt;

  if (isPredict) {
    predictPrompts.push(prompt);
    const send = /\[(\d+)\] button "Send reply"/.exec(prompt);
    if (!send || prompt.includes('clicked button "Send reply"')) {
      return JSON.stringify({ action: "none", target: 0, value: "", label: "", confidence: 0.1, irreversible: false });
    }
    return JSON.stringify({
      action: "click",
      target: Number(send[1]),
      value: "",
      label: "Send reply",
      confidence: 0.9,
      irreversible: true,
    });
  }

  textPrompts.push(prompt);
  const typed = /<typed>([\s\S]*)<\/typed>/.exec(prompt)?.[1] ?? "";
  return typed.endsWith(SUGGESTION.trim()) ? "" : SUGGESTION;
}

// ---------------------------------------------------------------- mock API

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors()).end();
    return;
  }

  if (req.url.startsWith("/v1/")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      requestCount++;
      let reply = "";
      try {
        reply = mockReply(JSON.parse(body));
      } catch {
        lastPrompt = body;
      }
      res.writeHead(200, { ...cors(), "Content-Type": "text/event-stream" });
      // Stream in chunks, with a beat before the first one, so the streaming
      // path is actually exercised rather than short-circuited.
      await sleep(60);
      for (const piece of reply.match(/\S+\s*|\s+/g) ?? []) {
        res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: piece })}\n\n`);
        await sleep(15);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }

  // Fixtures are served over http so content scripts run without the
  // "allow access to file URLs" profile toggle.
  const rel = req.url.split("?")[0].replace(/^\/+/, "");
  const file = path.join(here, rel);
  if (!file.startsWith(here) || !fs.existsSync(file)) {
    res.writeHead(404, cors()).end("not found");
    return;
  }
  res.writeHead(200, { ...cors(), "Content-Type": MIME[path.extname(file)] ?? "text/plain" });
  res.end(fs.readFileSync(file));
});

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------- CDP

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessions = new Set();
    this.events = [];
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method) {
        this.events.push(msg);
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 20000);
    });
  }

  close() {
    this.ws.close();
  }
}

async function attach(browser, targetId) {
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  return sessionId;
}

async function evaluate(browser, sessionId, expression) {
  const result = await browser.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return result.result?.value;
}

/** Walk a pierced DOM tree, including closed shadow roots. */
function findByClass(node, className, out = []) {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === "class" && attrs[i + 1].split(/\s+/).includes(className)) {
      out.push(node);
    }
  }
  for (const child of node.children ?? []) findByClass(child, className, out);
  for (const shadow of node.shadowRoots ?? []) findByClass(shadow, className, out);
  if (node.contentDocument) findByClass(node.contentDocument, className, out);
  return out;
}

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  return (node.children ?? []).map(textOf).join("");
}

// ------------------------------------------------------------------- test

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
}

let chrome;
let browser;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "carat-e2e-"));

async function main() {
  if (!fs.existsSync(path.join(dist, "manifest.json"))) {
    throw new Error("dist/ is missing - run `npm run build` first");
  }

  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  console.log(`mock OpenAI + fixtures on http://127.0.0.1:${PORT}`);

  const exe =
    process.env.CHROME_PATH ??
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-allow-origins=*",
    // Chrome no longer honours --load-extension; unpacked extensions are loaded
    // over CDP (Extensions.loadUnpacked) instead, which this flag permits.
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--window-size=1280,900",
    "about:blank",
  ];
  if (!HEADED) args.unshift("--headless=new");

  chrome = spawn(exe, args, { stdio: "ignore" });
  console.log(`chrome pid ${chrome.pid}${HEADED ? " (headed)" : " (headless)"}`);

  // --- connect ------------------------------------------------------------
  let version;
  for (let i = 0; i < 40; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error("Chrome never opened its debugging port");
  browser = await Cdp.connect(version.webSocketDebuggerUrl);
  await browser.send("Target.setDiscoverTargets", { discover: true });

  // --- load the extension -------------------------------------------------
  const loaded = await browser.send("Extensions.loadUnpacked", { path: dist }).catch((e) => {
    console.log(`  Extensions.loadUnpacked failed: ${e.message}`);
    return null;
  });
  const extensionId = loaded?.id;
  check("extension loads", Boolean(extensionId), extensionId);
  if (!extensionId) return;

  // Its service worker is where chrome.storage lives.
  let extensionTarget = null;
  for (let i = 0; i < 40 && !extensionTarget; i++) {
    const { targetInfos } = await browser.send("Target.getTargets");
    if (process.env.CARAT_DEBUG && i === 0) {
      for (const t of targetInfos) console.log(`  ${t.type}  ${t.url}`);
    }
    extensionTarget = targetInfos.find(
      (t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`),
    );
    if (!extensionTarget) await sleep(250);
  }
  check("service worker starts", Boolean(extensionTarget), extensionTarget?.url.split("/").pop());
  if (!extensionTarget) return;

  // --- configure it the way a user would: through the options page --------
  // (chrome.storage is not reachable from an attached worker session, and
  // driving the real form exercises the options page at the same time.)
  const settings = {
    apiKey: API_KEY,
    model: MODEL,
    api: "responses",
    baseUrl: BASE_URL,
    enabled: true,
    debounceMs: 150,
    maxOutputTokens: 48,
    blocklist: [],
    useAccessibilityTree: !NO_CDP,
  };

  const worker = await attach(browser, extensionTarget.targetId);
  await browser.send("Runtime.enable", {}, worker);

  let stored = null;
  for (let i = 0; i < 12 && stored !== BASE_URL; i++) {
    try {
      stored = await evaluate(
        browser,
        worker,
        `chrome.storage.local.set(${JSON.stringify(settings)})
           .then(() => chrome.storage.local.get(null))
           .then((s) => s.baseUrl)`,
      );
    } catch (err) {
      if (process.env.CARAT_DEBUG) console.log(`  settings attempt ${i}: ${err.message}`);
      await sleep(400);
    }
  }
  check("settings save", stored === BASE_URL, stored);

  // --- open the fixture ---------------------------------------------------
  const fixture = `http://127.0.0.1:${PORT}/fixtures/form.html`;
  const { targetId } = await browser.send("Target.createTarget", { url: fixture });
  const page = await attach(browser, targetId);
  await browser.send("Page.enable", {}, page);
  await browser.send("Runtime.enable", {}, page);
  await browser.send("DOM.enable", {}, page);
  await sleep(1500); // content script + first port connect

  const title = await evaluate(browser, page, "document.title");
  check("fixture page loads", title.includes("Ticket #4821"), title);

  // --- type ---------------------------------------------------------------
  await evaluate(browser, page, `document.getElementById("body").focus()`);
  const typed = "Thanks for the details. Could you";
  await browser.send("Input.insertText", { text: typed }, page);

  // debounce (150ms) + first-token latency + stream
  await sleep(LIVE ? 7000 : 2500);

  if (process.env.CARAT_DEBUG) {
    await browser.send("Accessibility.enable", {}, page);
    const { nodes } = await browser.send("Accessibility.getFullAXTree", {}, page);
    const byRole = new Map();
    for (const n of nodes) {
      const role = n.role?.value ?? "?";
      byRole.set(role, (byRole.get(role) ?? 0) + 1);
    }
    fs.mkdirSync(path.join(here, ".tmp"), { recursive: true });
    fs.writeFileSync(path.join(here, ".tmp", "axtree.json"), JSON.stringify(nodes, null, 1));
    console.log(`\n  raw AX tree: ${nodes.length} nodes (saved to test/.tmp/axtree.json)`);
    console.log(
      "  roles: " +
        [...byRole].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}:${n}`).join(" "),
    );
    for (const n of nodes) {
      if (["textbox", "combobox", "searchbox"].includes(n.role?.value)) {
        const focused = n.properties?.find((p) => p.name === "focused")?.value?.value;
        console.log(
          `    ${n.role.value} name=${JSON.stringify(n.name?.value)} focused=${focused} ignored=${n.ignored}`,
        );
      }
    }
    console.log();
  }

  // --- did a request go out, and what was in it? --------------------------
  if (!LIVE) {
    check("extension called the API", requestCount > 0, `${requestCount} request(s)`);

    const prompt = textPrompts[0] ?? "";
    check("prompt marks the focused field", prompt.includes(">> FOCUSED"));
    check("prompt carries the typed text", prompt.includes(`<typed>${typed}</typed>`));
    check(
      "prompt carries page context the field itself does not have",
      prompt.includes("3.2.0.4711") || prompt.includes("firmware"),
    );
    check("prompt carries sibling form fields", prompt.includes("Awaiting customer"));

    check("prompt carries the conversation above the reply box", prompt.includes("3.2.0.4711"));
    check(
      "prompt does not feed our own ghost text back in",
      !prompt.includes(SUGGESTION.trim()),
    );
  }

  // --- ghost text ---------------------------------------------------------
  const { root: domRoot } = await browser.send("DOM.getDocument", { depth: -1, pierce: true }, page);
  const ghostNodes = findByClass(domRoot, "ghost");
  const ghostText = ghostNodes.map(textOf).join("");
  check("ghost text is rendered", ghostText.trim().length > 0, JSON.stringify(ghostText.slice(0, 80)));
  if (!LIVE) {
    check("ghost text matches the completion", SUGGESTION.startsWith(ghostText) && ghostText.length > 8);
  }

  // The completion is concatenated verbatim, so it owns the space at the seam.
  check(
    "completion joins cleanly at the caret",
    !(/\w$/.test(typed) && /^\w/.test(ghostText)),
    JSON.stringify(typed.slice(-8) + "|" + ghostText.slice(0, 14)),
  );

  const mirrorTyped = findByClass(domRoot, "typed").map(textOf).join("");
  check("mirror echoes the typed text for alignment", mirrorTyped === typed, JSON.stringify(mirrorTyped.slice(0, 40)));

  // --- accept with Tab ----------------------------------------------------
  const before = await evaluate(browser, page, `document.getElementById("body").value`);
  await browser.send(
    "Input.dispatchKeyEvent",
    { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    page,
  );
  await browser.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    page,
  );
  await sleep(400);

  const after = await evaluate(browser, page, `document.getElementById("body").value`);
  check("Tab accepts the suggestion", after.length > before.length, JSON.stringify(after.slice(-48)));
  check("accepted text is the suggestion", after === typed + ghostText, JSON.stringify(after));

  const stillFocused = await evaluate(
    browser,
    page,
    `document.activeElement && document.activeElement.id`,
  );
  check("Tab did not move focus", stillFocused === "body", `activeElement #${stillFocused}`);

  // --- the debug HUD reports the context source --------------------------
  for (const type of ["keyDown", "keyUp"]) {
    await browser.send(
      "Input.dispatchKeyEvent",
      {
        type,
        key: ".",
        code: "Period",
        windowsVirtualKeyCode: 190,
        nativeVirtualKeyCode: 190,
        modifiers: 2 | 8, // ctrl + shift
      },
      page,
    );
  }
  await sleep(400);
  const { root: hudRoot } = await browser.send("DOM.getDocument", { depth: -1, pierce: true }, page);
  const hudText = findByClass(hudRoot, "panel").map(textOf).join(" ");
  check("debug HUD opens", hudText.includes("Carat"), hudText.slice(0, 40).replace(/\s+/g, " "));
  check(
    NO_CDP ? "context came from the DOM fallback" : "context came from the CDP accessibility tree",
    hudText.includes(NO_CDP ? "DOM fallback" : "CDP accessibility tree"),
    hudText.includes("DOM fallback") ? "HUD reports DOM fallback" : "",
  );

  // Accepting re-anchors the mirror on the new text (and chains a follow-up
  // suggestion), rather than leaving a stale ghost behind.
  const mirrorAfter = findByClass(hudRoot, "typed").map(textOf).join("");
  check(
    "mirror re-anchors on the accepted text",
    mirrorAfter === "" || after.startsWith(mirrorAfter),
    JSON.stringify(mirrorAfter.slice(-30)),
  );

  // --- next-action prediction -------------------------------------------
  // With the reply written, the text model has nothing to add, so Carat asks
  // what the user will do next instead.
  await sleep(LIVE ? 7000 : 2500);

  const pressTab = async () => {
    for (const type of ["keyDown", "keyUp"]) {
      await browser.send(
        "Input.dispatchKeyEvent",
        { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
        page,
      );
    }
    await sleep(300);
  };

  const readOverlay = async () => {
    const { root } = await browser.send("DOM.getDocument", { depth: -1, pierce: true }, page);
    const ring = findByClass(root, "ring")[0];
    const chip = findByClass(root, "chip")[0];
    const style = (node) => {
      const attrs = node?.attributes ?? [];
      const i = attrs.indexOf("style");
      return i === -1 ? "" : attrs[i + 1];
    };
    return {
      ringShown: Boolean(ring) && /display:\s*block/.test(style(ring)),
      chip: chip ? textOf(chip) : "",
      chipShown: Boolean(chip) && !/display:\s*none/.test(style(chip)),
      hud: findByClass(root, "panel").map(textOf).join(" "),
    };
  };

  const sentVisible = () => evaluate(browser, page, `!document.getElementById("sent").hidden`);

  if (LIVE) {
    const view = await readOverlay();
    const predicted = /next action(.*?)predictions/.exec(view.hud)?.[1] ?? "?";
    console.log(`  info  live model predicted: ${predicted}${view.ringShown ? ` - chip "${view.chip}"` : ""}`);
  } else {
    check("empty text completion triggers a prediction", predictPrompts.length > 0, `${predictPrompts.length} request(s)`);
    const first = predictPrompts[0] ?? "";
    if (first) {
      console.log("\n--- action prompt the extension sent ---\n" + first + "\n----------------------------------------\n");
    }
    check("action prompt numbers the controls", /\[\d+\] button "Send reply"/.test(first));
    check(
      "action prompt includes what the user wrote",
      /FOCUSED \[\d+\] textbox "Reply body" = Thanks for the details/.test(first),
    );
    check("action prompt includes recent history", first.includes('opened "Ticket #4821'));

    const shown = await readOverlay();
    // On a short viewport the button is below the fold: the chip docks to the
    // bottom edge with an arrow instead of ringing an invisible element.
    const docked = !shown.ringShown && /↓|↑/.test(shown.chip);
    check(
      "predicted control is highlighted (or docked with an arrow if offscreen)",
      shown.chipShown && (shown.ringShown || docked),
      docked ? "offscreen: docked" : "ringed",
    );
    check("chip says what Tab will do", shown.chip.includes("Send reply"), JSON.stringify(shown.chip));
    check("irreversible action asks for two Tabs", shown.chip.includes("Tab Tab"));
    check("HUD shows the prediction", /click Send reply \(0\.90\)/.test(shown.hud));

    await pressTab();
    const armed = await readOverlay();
    check("first Tab only arms it", armed.chip.includes("again") && !(await sentVisible()), JSON.stringify(armed.chip));
    // Nobody should confirm a send they cannot see.
    check("arming scrolls the target into view", armed.ringShown && !/↓|↑/.test(armed.chip));

    await pressTab();
    check("second Tab clicks Send reply", await sentVisible());

    const cleared = await readOverlay();
    check("highlight clears after the action", !cleared.ringShown && !cleared.chipShown);

    await sleep(2000);
    const followUp = predictPrompts.at(-1) ?? "";
    check(
      "the click lands in history for the next prediction",
      predictPrompts.length > 1 && followUp.includes('clicked button "Send reply"'),
    );

    // A stray Tab after the highlight is gone must behave like a normal Tab.
    await evaluate(browser, page, `document.getElementById("subject").focus()`);
    await pressTab();
    const landed = await evaluate(browser, page, "document.activeElement && document.activeElement.id");
    check("Tab is left alone when nothing is suggested", landed === "body", `focus moved to #${landed}`);
  }

  const noise = browser.events.filter(
    (e) => e.method === "Runtime.exceptionThrown" || e.method === "Runtime.consoleAPICalled",
  );
  if (noise.length) {
    console.log("\nworker console:");
    for (const e of noise) {
      if (e.method === "Runtime.exceptionThrown") {
        const d = e.params.exceptionDetails;
        console.log(`  EXCEPTION ${d.exception?.description ?? d.text}`);
      } else {
        const args = e.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
        console.log(`  console.${e.params.type}: ${args}`);
      }
    }
  }

  console.log(`\nextension id ${extensionId}`);
}

try {
  await main();
} catch (err) {
  console.error("\nharness error:", err.message);
  results.push({ name: "harness", ok: false, detail: err.message });
} finally {
  browser?.close();
  chrome?.kill();
  await sleep(400);
  try {
    server.close();
  } catch {}
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} failing` : "\nall passing");
process.exit(failed.length ? 1 : 0);
