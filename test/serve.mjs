/**
 * Serves test/fixtures over http so content scripts run on them without the
 * per-extension "Allow access to file URLs" toggle.
 *
 *   npm run fixtures      -> http://localhost:8124/
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "fixtures");
const PORT = Number(process.env.PORT ?? 8124);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const PAGES = [
  ["form.html", "Support ticket — the demo page. Click into Reply body."],
  ["tracked-input.html", "React-style value tracker — accepting must turn the verdict green."],
  ["metrics.html", "Awkward text metrics — check ghost alignment in every field."],
];

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");

    if (!rel) {
      const links = PAGES.map(
        ([file, why]) => `<li><a href="/${file}">${file}</a><span>${why}</span></li>`,
      ).join("");
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      res.end(`<!doctype html><meta charset="utf-8"><title>Carat fixtures</title>
<style>
  body{font:15px/1.7 system-ui,sans-serif;max-width:640px;margin:0 auto;padding:48px 20px;color:#11151c}
  h1{font-size:20px;margin:0 0 6px} p{color:#5d6b7f;margin:0 0 28px}
  ul{list-style:none;padding:0} li{margin:0 0 16px}
  a{font-weight:600;font-size:16px} span{display:block;color:#5d6b7f;font-size:13px}
  kbd{font:12px ui-monospace,Menlo,monospace;border:1px solid #d9dee7;border-bottom-width:2px;border-radius:4px;padding:1px 5px}
</style>
<h1>Carat test fixtures</h1>
<p><kbd>Tab</kbd> accept · <kbd>Esc</kbd> dismiss · <kbd>Ctrl</kbd>+<kbd>.</kbd> force · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> debug HUD</p>
<ul>${links}</ul>`);
      return;
    }

    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "text/plain" });
    res.end(fs.readFileSync(file));
  })
  .listen(PORT, () => {
    console.log(`fixtures on http://localhost:${PORT}/`);
    for (const [file] of PAGES) console.log(`  http://localhost:${PORT}/${file}`);
  });
