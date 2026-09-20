// Static server for test/fixtures: npm run fixtures → http://localhost:8787/
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, "fixtures");
const port = Number(process.env.PORT ?? 8787);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([\/])+/, "");
  try {
    if (!path) {
      const files = (await readdir(root)).filter((f) => f.endsWith(".html"));
      res.writeHead(200, { "content-type": types[".html"] });
      res.end(`<h1>Carat fixtures</h1><ul>${files.map((f) => `<li><a href="/${f}">${f}</a></li>`).join("")}</ul>`);
      return;
    }
    const body = await readFile(join(root, path));
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`fixtures on http://localhost:${port}/`));
