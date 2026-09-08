import { build } from "rolldown";

// Obsidian のプラグインは CommonJS の main.js 単体を読む。obsidian と electron は
// ホストが提供するので束ねない。
await build({
  input: "src/main.ts",
  platform: "browser",
  external: ["obsidian", "electron"],
  transform: { target: "es2022" },
  output: {
    file: "main.js",
    format: "cjs",
    minify: process.argv.includes("--production"),
    sourcemap: process.argv.includes("--production") ? false : "inline",
  },
});
