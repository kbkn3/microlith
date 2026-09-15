import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { mergeNote } from "../src/merge.ts";

test("merges non-overlapping edits", () => {
  assert.equal(mergeNote("一\nB\n", "A\nB\n", "A\n二\n"), "一\n二\n");
});

test("keeps identical edits", () => {
  assert.equal(mergeNote("同じ", "元", "同じ"), "同じ");
});

test("preserves CRLF line endings", () => {
  assert.equal(mergeNote("左\r\nB\r\n", "A\r\nB\r\n", "A\r\n右\r\n"), "左\r\n右\r\n");
});

test("preserves missing trailing newline", () => {
  assert.equal(mergeNote("左\nB", "A\nB", "A\n右"), "左\n右");
});

test("reports same-line edits as a conflict", () => {
  assert.equal(mergeNote("左\n", "元\n", "右\n"), null);
});
