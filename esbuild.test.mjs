import { build } from "esbuild";

await build({
  entryPoints: ["test/run.ts"],
  outfile: "test/.tmp/run.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node20"],
  logLevel: "warning",
});
