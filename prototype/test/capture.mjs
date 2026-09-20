// Capture a page's accessibility tree with headless Chrome and print Carat's
// outlines and prompts for it, exactly as the worker would build them.
//
//   node test/capture.mjs [url] [--focus=<css>] [--type=<text>]
//
// Defaults to the support fixture with the reply box focused. The raw tree is
// saved to test/.tmp/axtree.json.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const tmp = join(import.meta.dirname, ".tmp");
mkdirSync(tmp, { recursive: true });

let url = args.find((a) => !a.startsWith("--"));
let server;
if (!url) {
  server = spawn(process.execPath, [join(import.meta.dirname, "serve.mjs")], { env: { ...process.env, PORT: "8788" } });
  await new Promise((r) => server.stdout.once("data", r));
  url = "http://localhost:8788/support.html";
}
const focus = flag("focus") ?? (url.includes("support.html") ? "#body" : null);
const typed = flag("type") ?? (url.includes("support.html") ? "Thanks for the details. Could you" : "");

const chromePath =
  process.env.CHROME_PATH ??
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(existsSync);
const chrome = spawn(chromePath, [
  "--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${join(tmp, "profile")}`,
  "--no-first-run", "--no-default-browser-check", "about:blank",
]);

async function version() {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch("http://127.0.0.1:9334/json/version")).json();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket((await version()).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
const waiters = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) {
    for (const w of waiters) if (w.method === msg.method) w.resolve(msg.params);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
const once = (method) => new Promise((resolve) => waiters.push({ method, resolve }));

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s("Page.enable");
  const loaded = once("Page.loadEventFired");
  await s("Page.navigate", { url });
  await loaded;
  await new Promise((r) => setTimeout(r, 500));

  if (focus) {
    await s("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(focus)}).focus()` });
    if (typed) await s("Input.insertText", { text: typed });
  }

  await s("Accessibility.enable");
  const t0 = performance.now();
  const { nodes } = await s("Accessibility.getFullAXTree");
  const fetchMs = Math.round(performance.now() - t0);
  const { result } = await s("Runtime.evaluate", { expression: "document.activeElement" });
  let focusedBackendId = null;
  if (result.objectId && result.description !== "body") {
    focusedBackendId = (await s("DOM.describeNode", { objectId: result.objectId })).node.backendNodeId;
  }
  writeFileSync(join(tmp, "axtree.json"), JSON.stringify(nodes, null, 1));

  const out = join(tmp, "outline-runner.mjs");
  await esbuild.build({
    stdin: {
      contents: `
        export { buildOutline } from "./src/background/outline.ts";
        export { buildTextRequest, buildActionRequest } from "./src/background/prompts.ts";
        export { DEFAULT_SETTINGS } from "./src/shared/settings.ts";`,
      resolveDir: join(import.meta.dirname, ".."),
      loader: "ts",
    },
    bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error",
  });
  const { buildOutline, buildTextRequest, buildActionRequest, DEFAULT_SETTINGS } = await import(pathToFileURL(out).href);

  const common = { url, focusedBackendId };
  const text = buildOutline(nodes, { ...common, mode: "text" });
  const action = buildOutline(nodes, { ...common, mode: "action", focusedValue: typed });
  const line = "─".repeat(72);
  console.log(`${nodes.length} AX nodes, fetched in ${fetchMs}ms, focused backendNodeId ${focusedBackendId}\n`);
  console.log(`${line}\nTEXT OUTLINE (${text.stats.chars} chars)\n${line}\n${text.text}\n`);
  console.log(`${line}\nACTION OUTLINE (${action.stats.chars} chars, ${action.candidates.length} targets)\n${line}\n${action.text}\n`);
  if (typed) {
    const field = { tag: "textarea", inputType: "textarea", multiline: true, name: "", placeholder: "", maxLength: null, typed, trailing: "", redacted: false };
    const req = buildTextRequest({ settings: DEFAULT_SETTINGS, url, outline: text.text, field, axName: text.focused?.name, axRole: text.focused?.role });
    console.log(`${line}\nTEXT PROMPT (user turn)\n${line}\n${req.input.at(-1).content}\n`);
  }
  const areq = buildActionRequest({ settings: DEFAULT_SETTINGS, url, outline: action.text, history: "(nothing yet)" });
  console.log(`${line}\nACTION PROMPT (user turn)\n${line}\n${areq.input.at(-1).content}`);
} finally {
  ws.close();
  chrome.kill();
  server?.kill();
}
