import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: {
    "background/index": "src/background/index.ts",
    "content/index": "src/content/index.ts",
    "options/options": "src/options/options.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: ["chrome120"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

async function copyStatic() {
  await cp("src/manifest.json", "dist/manifest.json");
  await mkdir("dist/options", { recursive: true });
  await cp("src/options/options.html", "dist/options/options.html");
  await cp("src/icons", "dist/icons", { recursive: true });
}

await rm("dist", { recursive: true, force: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await copyStatic();
  console.log("[carat] watching…");
} else {
  await build(options);
  await copyStatic();
  console.log("[carat] built dist/");
}
