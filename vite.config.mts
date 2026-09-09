import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    target: "es2022",
    outDir: "packages/blade",
    emptyOutDir: false,
    minify: false,
    sourcemap: "inline",
    lib: {
      entry: "packages/blade/src/main.ts",
      formats: ["cjs"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      external: ["obsidian", "electron"],
    },
  },
  fmt: {},
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "vitest"],
    options: {
      denyWarnings: true,
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "typescript/no-base-to-string": "off",
      "typescript/restrict-template-expressions": "off",
    },
  },
  test: {
    testTimeout: 30_000,
  },
});
