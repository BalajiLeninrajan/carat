/**
 * Replays a real accessibility tree captured from Chrome (test/.tmp/axtree.json,
 * written by `node test/e2e.mjs` under CARAT_DEBUG=1) through the outline
 * builder, so the builder can be debugged without launching a browser.
 */
import fs from "node:fs";
import { buildOutline } from "../src/background/context.js";
import type { AXNode } from "../src/background/ax.js";
import type { FieldInfo } from "../src/shared/types.js";

const nodes: AXNode[] = JSON.parse(fs.readFileSync("test/.tmp/axtree.json", "utf8"));

const field: FieldInfo = {
  role: "textbox",
  name: "Reply body",
  placeholder: "Write your reply…",
  multiline: true,
  maxLength: null,
  inputType: "textarea",
  typed: "Thanks for the details. Could you",
  trailing: "",
};

const result = buildOutline(
  nodes,
  field,
  "http://127.0.0.1:8123/fixtures/form.html",
  "Ticket #4821 — Support Desk",
);

console.log(`focusedFound: ${result.focusedFound}`);
console.log(`${result.text.length} chars\n`);
console.log(result.text);
