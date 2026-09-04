import esbuild from "esbuild";

// Obsidian のプラグインは CommonJS の main.js 単体を読む。obsidian と electron は
// ホストが提供するので束ねない。
await esbuild.build({
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "browser",
  external: ["obsidian", "electron"],
  logLevel: "info",
  minify: process.argv.includes("--production"),
  sourcemap: process.argv.includes("--production") ? false : "inline"
});
