import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { SyncEngine, conflictCopyPath } from "../src/sync.ts";

const baseBody = "first\nsecond\n";
const localBody = "local\nsecond\n";
const remoteBody = "first\nremote\n";
const mergedBody = "local\nremote\n";

function fixture(configuration = {}) {
  const operations = [];
  const requests = [];
  const files = new Map([["note.md", localBody]]);
  const revisions = new Map([["note.md", "base-revision"]]);
  const outcome = {
    status: "conflict",
    rev: "remote-revision",
    body: remoteBody,
    baseBody,
    ...configuration.outcome,
  };
  const vault = {
    list: async () => [...files.keys()],
    read: async (path) => files.get(path),
    exists: async (path) => files.has(path),
    mtime: async () => 1,
    indexOf: () => ({ marker: "stale-index" }),
    async write(path, body) {
      operations.push(path === "note.md" ? "write original" : "write conflict copy");
      if (path !== "note.md" && configuration.copyWriteThrows) throw new Error("copy write failed");
      files.set(path, body);
    },
    async remove(path) {
      operations.push("remove original");
      files.delete(path);
    },
    async writeAndWaitForIndex(path, body) {
      assert.equal(engine.isApplying(path), true);
      operations.push("write merged body");
      files.set(path, body);
      if (configuration.indexThrows) throw new Error("index failed");
      return configuration.missingIndex ? null : { marker: "merged-body-index" };
    },
  };
  if (configuration.missingMethod) delete vault.writeAndWaitForIndex;
  const state = {
    lastSeq: 0,
    revOf: (path) => revisions.get(path) ?? null,
    setRev: (path, revision) => {
      if (revision === null) revisions.delete(path);
      else revisions.set(path, revision);
    },
    paths: () => [...revisions.keys()],
    save: async () => {},
  };
  const client = {
    async pushNote(input) {
      requests.push(input);
      if (input.path !== "note.md") {
        if (configuration.copyPushThrows) throw new Error("copy push failed");
        return { status: "ok", seq: 3, rev: "copy-revision" };
      }
      if (requests.filter((request) => request.path === "note.md").length === 1) return outcome;
      if (configuration.retryThrows) throw new Error("request failed");
      return configuration.retryOutcome ?? { status: "ok", seq: 2, rev: "merged-revision" };
    },
    changes: async () => ({
      status: "ok",
      seq: 1,
      hasMore: false,
      changes: [
        { path: "note.md", rev: outcome.rev, kind: "note", deleted: outcome.body === null },
      ],
    }),
    readNote: async () => ({ rev: outcome.rev, body: outcome.body }),
  };
  const engine = new SyncEngine(client, vault, state, {
    deviceName: "phone",
    automaticMerge: configuration.automaticMerge,
  });
  return { engine, files, state, requests, operations };
}

function assertFallback(context, body = remoteBody, revision = "remote-revision") {
  const copies = [...context.files.keys()].filter((path) => path !== "note.md");
  assert.equal(copies.length, 1);
  assert.equal(context.files.get(copies[0]), localBody, "退避する本文はマージ前の原文");
  assert.equal(context.files.get("note.md"), body ?? undefined);
  assert.equal(context.state.revOf("note.md"), body === null ? null : revision);
  assert.equal(context.state.revOf(copies[0]), "copy-revision");
  assert.deepEqual(context.operations.slice(-2), [
    "write conflict copy",
    body === null ? "remove original" : "write original",
  ]);
}

test("別行の競合を exact-body index と最新 revision で一度だけ再試行する", async () => {
  const context = fixture();
  await context.engine.pushPath("note.md");
  const retries = context.requests.slice(1);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].baseRev, "remote-revision");
  assert.equal(retries[0].body, mergedBody);
  assert.equal(retries[0].index.marker, "merged-body-index");
  assert.ok(retries[0].mtime > context.requests[0].mtime);
  assert.deepEqual([...context.files], [["note.md", mergedBody]]);
  assert.equal(context.state.revOf("note.md"), "merged-revision");
  assert.equal(context.engine.isApplying("note.md"), false);
});

for (const [name, configuration] of [
  ["同一行の競合", { outcome: { baseBody: "old\nsecond\n", body: "remote\nsecond\n" } }],
  ["baseBody の欠損", { outcome: { baseBody: undefined } }],
  ["自動マージ無効", { automaticMerge: false }],
  ["exact-body index の欠損", { missingIndex: true }],
  ["index 待機契約の未実装", { missingMethod: true }],
  ["index 待機の例外", { indexThrows: true }],
]) {
  test(`${name}ではマージを送らず原文を退避する`, async () => {
    const context = fixture(configuration);
    await context.engine.pushPath("note.md");
    assert.equal(context.requests.filter((request) => request.path === "note.md").length, 1);
    assertFallback(context, configuration.outcome?.body ?? remoteBody);
  });
}

for (const [name, configuration] of [
  [
    "再競合",
    { retryOutcome: { status: "conflict", rev: "remote-revision", body: remoteBody, baseBody } },
  ],
  ["リクエスト例外", { retryThrows: true }],
]) {
  test(`${name}では二度目の再試行をせずマージ前の原文を退避する`, async () => {
    const context = fixture(configuration);
    await context.engine.pushPath("note.md");
    assert.equal(context.requests.filter((request) => request.path === "note.md").length, 2);
    assertFallback(context);
  });
}

test("編集と削除の競合は原文の退避後に原本を削除する", async () => {
  const context = fixture({ outcome: { body: null } });
  await context.engine.pushPath("note.md");
  assert.equal(context.requests.filter((request) => request.path === "note.md").length, 1);
  assertFallback(context, null);
});

for (const body of ["newest remote body\n", null]) {
  test(`再競合時は最新のリモート${body === null ? "削除" : "本文"}を適用する`, async () => {
    const context = fixture({
      retryOutcome: { status: "conflict", rev: "newest-revision", body, baseBody: remoteBody },
    });
    await context.engine.pushPath("note.md");
    assert.equal(context.requests.filter((request) => request.path === "note.md").length, 2);
    assertFallback(context, body, "newest-revision");
  });
}

for (const [name, configuration] of [
  ["競合コピーの書き込み", { copyWriteThrows: true }],
  ["競合コピーの送信", { copyPushThrows: true }],
]) {
  test(`${name}が失敗しても原本をリモートで上書きしない`, async () => {
    const context = fixture({ ...configuration, automaticMerge: false });
    await assert.rejects(context.engine.pushPath("note.md"), /copy .* failed/);
    assert.equal(context.files.get("note.md"), localBody);
    assert.equal(context.state.revOf("note.md"), "base-revision");
  });
}

test("同じ分の競合コピーが存在しても過去の退避を上書きしない", async () => {
  const context = fixture({ automaticMerge: false });
  const existing = conflictCopyPath("note.md", "phone", new Date());
  context.files.set(existing, "earlier local body");
  await context.engine.pushPath("note.md");
  assert.equal(context.files.get(existing), "earlier local body");
  assert.equal([...context.files.values()].filter((body) => body === localBody).length, 1);
});

test("pull 中の別行編集も push の retained base 経路でマージする", async () => {
  const context = fixture();
  assert.equal(await context.engine.pull(), 1);
  assert.equal(context.requests.length, 2);
  assert.equal(context.requests[0].baseRev, "base-revision");
  assert.equal(context.files.get("note.md"), mergedBody);
});

test("pull 中の削除と編集も push の競合経路で原文を退避する", async () => {
  const context = fixture({ outcome: { body: null } });
  assert.equal(await context.engine.pull(), 1);
  assert.equal(context.requests[0].baseRev, "base-revision");
  assertFallback(context, null);
});
