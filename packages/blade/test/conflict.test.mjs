import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { contentHash } from "@microlith/haft";
import { SyncEngine, conflictCopyPath } from "../src/sync.ts";

const baseBody = "first\nsecond\n";
const localBody = "local\nsecond\n";
const remoteBody = "first\nremote\n";
const mergedBody = "local\nremote\n";

function fixture(configuration = {}) {
  const operations = [];
  const requests = [];
  const writes = [];
  const files = new Map([["note.md", localBody]]);
  const revisions = new Map([["note.md", "base-revision"]]);
  let saved = false;
  let reads = 0;
  const outcome = {
    status: "conflict",
    rev: "remote-revision",
    body: remoteBody,
    baseBody,
    ...configuration.outcome,
  };
  const vault = {
    list: async () => [...files.keys()],
    read: async (path) => {
      const snapshot = files.get(path);
      if (path === "note.md") {
        reads += 1;
        await configuration.duringRead?.({ engine, files, reads, snapshot });
      }
      return snapshot;
    },
    exists: async (path) => {
      const exists = files.has(path);
      await configuration.duringExists?.({ path, files });
      return exists;
    },
    mtime: async () => 1,
    indexOf: () => ({ marker: "stale-index" }),
    async write(path, body) {
      writes.push({ path, body });
      operations.push(path === "note.md" ? "write original" : "write conflict copy");
      if (path !== "note.md" && configuration.copyWriteThrows) throw new Error("copy write failed");
      files.set(path, body);
    },
    async remove(path) {
      operations.push("remove original");
      files.delete(path);
    },
    async create(path, body) {
      await configuration.duringCreate?.({ path, files });
      if (configuration.createThrows) throw new Error("create failed");
      if (files.has(path)) throw new Error(`${path} already exists`);
      await vault.write(path, body);
    },
    async replaceIfUnchanged(path, expectedBody, body) {
      if (files.get(path) !== expectedBody) return false;
      await vault.write(path, body);
      return true;
    },
    async writeAndWaitForIndex(path, body, expectedBody) {
      assert.equal(engine.isApplying(path), true);
      if (files.get(path) !== expectedBody) return { applied: false };
      if (configuration.writeThrows) throw new Error("write failed");
      operations.push("write merged body");
      files.set(path, body);
      await configuration.duringIndex?.({ engine, files });
      return {
        applied: true,
        index: configuration.missingIndex ? null : { marker: "merged-body-index" },
      };
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
    save: async () => {
      if (saved) return;
      saved = true;
      await configuration.duringSave?.({ engine, files });
    },
  };
  const client = {
    async pushNote(input) {
      requests.push(input);
      if (input.path !== "note.md") {
        if (requests.filter((request) => request.path !== "note.md").length === 1)
          await configuration.duringCopyPush?.({ engine, files });
        if (configuration.copyPushThrows) throw new Error("copy push failed");
        if (configuration.copyPushConflicts) {
          return { status: "conflict", rev: "other-copy-revision", body: "other local body" };
        }
        return { status: "ok", seq: 3, rev: "copy-revision" };
      }
      if (requests.filter((request) => request.path === "note.md").length === 1) return outcome;
      if (requests.filter((request) => request.path === "note.md").length === 2)
        await configuration.duringRetry?.({ engine, files, input });
      if (requests.filter((request) => request.path === "note.md").length === 2) {
        if (configuration.retryThrows) throw new Error("request failed");
        if (configuration.retryOutcome) return configuration.retryOutcome;
      }
      return { status: "ok", seq: 2, rev: "merged-revision" };
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
  return { engine, files, state, client, requests, operations, writes };
}

function assertFallback(context, body = remoteBody, revision = "remote-revision") {
  const copies = [...context.files.keys()].filter((path) => path !== "note.md");
  assert.equal(copies.length, 1);
  assert.equal(context.files.get(copies[0]), localBody, "退避する本文はマージ前の原文");
  assert.equal(context.files.get("note.md"), body ?? localBody);
  assert.equal(context.state.revOf("note.md"), body === null ? "merged-revision" : revision);
  assert.equal(context.state.revOf(copies[0]), "copy-revision");
  if (body === null) {
    assert.equal(context.operations.includes("remove original"), false);
    assert.equal(context.requests.at(-1).path, "note.md");
    assert.equal(context.requests.at(-1).body, localBody);
    assert.equal(context.requests.at(-1).baseRev, null);
  } else {
    assert.deepEqual(context.operations.slice(-2), ["write conflict copy", "write original"]);
  }
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

test("マージ結果が手元と同じなら index を待たず現在の index で再試行する", async () => {
  // 送信済みの本文を古い base で再送した場合、サーバは unchanged ではなく conflict を返す。
  const context = fixture({ outcome: { body: localBody, baseBody }, missingIndex: true });
  await context.engine.pushPath("note.md");
  assert.equal(context.operations.includes("write merged body"), false);
  const retries = context.requests.slice(1);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].baseRev, "remote-revision");
  assert.equal(retries[0].body, localBody);
  assert.equal(retries[0].index.marker, "stale-index");
  assert.deepEqual([...context.files], [["note.md", localBody]]);
  assert.equal(context.state.revOf("note.md"), "merged-revision");
});

test("競合待機中の pull を完了後に処理して最新 remote へ収束する", async () => {
  const newerBody = "first\nremote changed again\n";
  const newerRevision = await contentHash(newerBody);
  let deferredSequence;
  const context = fixture({
    outcome: { rev: await contentHash(remoteBody) },
    missingIndex: true,
    duringIndex: async ({ engine }) => {
      context.client.changes = async (since) => ({
        status: "ok",
        seq: 10,
        hasMore: false,
        changes:
          since < 10 ? [{ path: "note.md", rev: newerRevision, kind: "note", deleted: false }] : [],
      });
      context.client.readNote = async () => ({ rev: newerRevision, body: newerBody });
      await engine.pull();
      deferredSequence = context.state.lastSeq;
    },
  });
  await context.engine.pushPath("note.md");
  assert.equal(context.files.get("note.md"), newerBody);
  assert.equal(context.state.revOf("note.md"), newerRevision);
  assert.equal(context.state.lastSeq, 10);
  assert.equal(deferredSequence, 0, "未適用の変更へカーソルを進めない");
  assert.ok([...context.files.values()].includes(localBody));
  await context.engine.pull();
  assert.equal(context.files.get("note.md"), newerBody);
});

for (const deleted of [false, true]) {
  test(`pull の${deleted ? "削除確認" : "本文取得"}中に保留された編集を失わない`, async () => {
    const editedBody = "edit queued during pull\n";
    let existenceChecks = 0;
    const context = fixture({
      automaticMerge: false,
      outcome: { body: deleted ? null : remoteBody },
      duringExists: async ({ path, files }) => {
        if (!deleted || path !== "note.md" || ++existenceChecks !== 2) return;
        files.set(path, editedBody);
        await context.engine.pushPath(path);
      },
    });
    context.state.setRev("note.md", await contentHash(localBody));
    context.client.readNote = async () => {
      context.files.set("note.md", editedBody);
      await context.engine.pushPath("note.md");
      return { rev: "remote-revision", body: remoteBody };
    };
    await context.engine.pull();
    assert.ok([...context.files.values()].includes(editedBody), "保留中の編集が消えた");
    assert.ok(context.requests.some(({ body }) => body === editedBody));
  });
}

test("pull の削除確認中に未編集のノートが保留されても remote の削除を適用する", async () => {
  let existenceChecks = 0;
  const context = fixture({
    outcome: { body: null },
    duringExists: async ({ path }) => {
      if (path !== "note.md" || ++existenceChecks !== 2) return;
      // Sync now の pushAll は未編集のノートも保留する。
      await context.engine.pushPath(path);
    },
  });
  context.state.setRev("note.md", await contentHash(localBody));
  await context.engine.pull();
  assert.deepEqual([...context.files.keys()], []);
  assert.equal(context.state.revOf("note.md"), null);
  assert.deepEqual(context.requests, []);
});

test("pull の本文取得中に保留された削除が拒否されても remote 本文へ収束する", async () => {
  const revision = await contentHash(remoteBody);
  const localRevision = await contentHash(localBody);
  const context = fixture({ automaticMerge: false, outcome: { rev: revision } });
  context.state.setRev("note.md", localRevision);
  context.client.changes = async (since) => ({
    status: "ok",
    seq: 10,
    hasMore: false,
    changes: since < 10 ? [{ path: "note.md", rev: revision, kind: "note", deleted: false }] : [],
  });
  context.client.readNote = async () => {
    context.files.delete("note.md");
    await context.engine.pushPath("note.md");
    assert.equal(context.state.lastSeq, 0, "未適用の変更へカーソルを進めない");
    return { rev: revision, body: remoteBody };
  };
  const pushNote = context.client.pushNote.bind(context.client);
  const deletionOutcomes = [];
  context.client.pushNote = async (input) => {
    assert.equal(context.state.lastSeq, 0, "削除要求の完了前にカーソルを進めない");
    const outcome = await pushNote(input);
    deletionOutcomes.push(outcome.status);
    return outcome;
  };
  const save = context.state.save;
  context.state.save = async () => {
    if (context.state.lastSeq === 10) {
      assert.equal(context.files.get("note.md"), remoteBody, "未適用の本文を受信済みにしない");
      assert.equal(context.state.revOf("note.md"), revision);
    }
    await save();
  };
  await context.engine.pull();
  assert.equal(context.files.get("note.md"), remoteBody);
  assert.equal(context.state.revOf("note.md"), revision);
  assert.equal(context.state.lastSeq, 10);
  assert.deepEqual(deletionOutcomes, ["conflict"]);
  assert.deepEqual(
    context.requests.map(({ path, baseRev, deleted }) => ({ path, baseRev, deleted })),
    [{ path: "note.md", baseRev: localRevision, deleted: true }],
  );
  await context.engine.pull();
  assert.equal(context.files.get("note.md"), remoteBody);
  assert.equal(context.state.revOf("note.md"), revision);
  assert.equal(context.state.lastSeq, 10);
  assert.equal(context.requests.length, 1, "拒否された削除を新 revision で再送しない");
});

test("保留された削除の拒否を待つ間に再作成された本文を失わない", async () => {
  const editedBody = "recreated while deletion is pending\n";
  const context = fixture({ automaticMerge: false });
  context.state.setRev("note.md", await contentHash(localBody));
  context.client.readNote = async () => {
    context.files.delete("note.md");
    await context.engine.pushPath("note.md");
    return { rev: "remote-revision", body: remoteBody };
  };
  const pushNote = context.client.pushNote.bind(context.client);
  context.client.pushNote = async (input) => {
    const outcome = await pushNote(input);
    if (input.deleted) {
      context.files.set("note.md", editedBody);
      await context.engine.pushPath("note.md");
    }
    return outcome;
  };
  await context.engine.pull();
  assert.ok([...context.files.values()].includes(editedBody), "再作成された本文が消えた");
  assert.ok(context.requests.some(({ body }) => body === editedBody));
  assert.equal(context.requests.filter(({ deleted }) => deleted).length, 1);
});

for (const exists of [true, false]) {
  test(`通常 pull の本文取得中の未通知${exists ? "編集" : "新規作成"}を保持する`, async () => {
    const editedBody = "user edit while remote body is loading\n";
    const revision = await contentHash(remoteBody);
    const context = fixture({ automaticMerge: false, outcome: { rev: revision } });
    if (!exists) context.files.delete("note.md");
    context.state.setRev("note.md", exists ? await contentHash(localBody) : null);
    context.client.changes = async (since) => ({
      status: "ok",
      seq: 10,
      hasMore: false,
      changes: since < 10 ? [{ path: "note.md", rev: revision, kind: "note", deleted: false }] : [],
    });
    context.client.readNote = async () => {
      context.files.set("note.md", editedBody);
      return { rev: revision, body: remoteBody };
    };
    await context.engine.pull();
    assert.ok([...context.files.values()].includes(editedBody), "未通知の本文が消えた");
    assert.ok(context.requests.some(({ body }) => body === editedBody));
    assert.equal(context.files.get("note.md"), remoteBody);
    assert.equal(context.state.revOf("note.md"), revision);
    assert.equal(context.state.lastSeq, 10);
    await context.engine.pushPath("note.md");
    assert.ok([...context.files.values()].includes(editedBody));
  });
}

test("pull の snapshot 読込中の削除が拒否されても一度の送信で remote へ収束する", async () => {
  const context = fixture({
    duringRead: ({ files, reads }) => {
      if (reads === 1) files.delete("note.md");
    },
  });
  await context.engine.pull();
  assert.equal(context.files.get("note.md"), remoteBody);
  assert.equal(context.state.revOf("note.md"), "remote-revision");
  assert.equal(context.requests.filter(({ deleted }) => deleted).length, 1);
});

test("pull の create と競合した未通知の新規本文を保持する", async () => {
  const editedBody = "created at the atomic write boundary\n";
  const context = fixture({
    automaticMerge: false,
    duringCreate: ({ path, files }) => {
      if (path === "note.md") files.set(path, editedBody);
    },
  });
  context.files.delete("note.md");
  context.state.setRev("note.md", null);
  await context.engine.pull();
  assert.ok([...context.files.values()].includes(editedBody));
  assert.ok(context.requests.some(({ body }) => body === editedBody));
  assert.equal(context.files.get("note.md"), remoteBody);
});

test("pull の create が失敗したら未適用の revision と seq を保存しない", async () => {
  const context = fixture({ createThrows: true });
  context.files.delete("note.md");
  context.state.setRev("note.md", null);
  await assert.rejects(context.engine.pull(), /create failed/);
  assert.equal(context.state.revOf("note.md"), null);
  assert.equal(context.state.lastSeq, 0);
});

test("並行する pull は取得と適用の順序を保ち lastSeq を逆行させない", async () => {
  const context = fixture();
  const cursors = [];
  let release;
  let entered;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  context.client.changes = async (since) => {
    cursors.push(since);
    if (cursors.length === 1) {
      entered();
      await pending;
      return { status: "ok", seq: 10, hasMore: false, changes: [] };
    }
    return { status: "ok", seq: 20, hasMore: false, changes: [] };
  };
  const first = context.engine.pull();
  await started;
  await context.engine.pull();
  release();
  await first;
  assert.deepEqual(cursors, [0, 10]);
  assert.equal(context.state.lastSeq, 20);
});

test("pull が失敗しても未適用 seq を保存せず次の同期を停止させない", async () => {
  const context = fixture();
  const cursors = [];
  context.client.changes = async (since) => {
    cursors.push(since);
    if (cursors.length === 1) {
      await context.engine.pull();
      throw new Error("offline");
    }
    return { status: "ok", seq: 7, hasMore: false, changes: [] };
  };
  await assert.rejects(context.engine.pull(), /offline/);
  assert.equal(context.state.lastSeq, 0);
  await context.engine.pull();
  assert.deepEqual(cursors, [0, 0]);
  assert.equal(context.state.lastSeq, 7);
});

test("metadata timeout 後の3回目の read 待機中の編集を失わない", async () => {
  const editedBody = "local\nremote\nedit while read is pending\n";
  let edited = false;
  const context = fixture({
    missingIndex: true,
    duringRead: async ({ engine, files, reads, snapshot }) => {
      if (reads !== 3) return;
      assert.equal(snapshot, mergedBody);
      assert.equal(engine.isApplying("note.md"), true);
      files.set("note.md", editedBody);
      edited = true;
      await engine.pushPath("note.md");
    },
  });
  await context.engine.pushPath("note.md");
  assert.equal(edited, true);
  assert.ok([...context.files.values()].includes(editedBody), "read 待機中の編集が消えた");
  assert.ok(context.requests.some(({ body }) => body === editedBody));
});

test("マージ適用拒否時に mergedBody と同一の利用者編集を rollback しない", async () => {
  const context = fixture({
    duringRead: async ({ engine, files, reads, snapshot }) => {
      if (reads !== 2) return;
      assert.equal(snapshot, localBody);
      assert.equal(engine.isApplying("note.md"), true);
      files.set("note.md", mergedBody);
      await engine.pushPath("note.md");
    },
  });
  await context.engine.pushPath("note.md");
  assert.ok([...context.files.values()].includes(mergedBody), "CAS 拒否後に利用者編集が消えた");
  assert.ok(context.requests.some(({ body }) => body === mergedBody));
  assert.equal(context.operations.includes("write merged body"), false);
});

for (const [timing, configuration, readNumber] of [
  ["マージ適用", {}, 2],
  ["リモート本文適用", { automaticMerge: false }, 4],
  ["リモート削除", { outcome: { body: null } }, 4],
]) {
  test(`${timing}の read snapshot 取得後の編集を保存して同期する`, async () => {
    const editedBody = "local\nsecond\nedit after snapshot\n";
    let edited = false;
    const context = fixture({
      ...configuration,
      duringRead: async ({ engine, files, reads }) => {
        if (reads !== readNumber) return;
        files.set("note.md", editedBody);
        edited = true;
        await engine.pushPath("note.md");
      },
    });
    await context.engine.pushPath("note.md");
    assert.equal(edited, true);
    assert.ok([...context.files.values()].includes(editedBody), "snapshot 後の編集が消えた");
    assert.ok(
      context.requests.some(({ body }) => body === editedBody),
      "編集が同期されていない",
    );
  });
}

for (const failure of ["timeout", "request", "conflict"]) {
  test(`マージ待機中の編集を ${failure} 後も競合コピーに残す`, async () => {
    const editedBody = "local\nremote\n編集中の追記\n";
    const context = fixture({
      missingIndex: failure === "timeout",
      retryThrows: failure === "request",
      retryOutcome:
        failure === "conflict"
          ? { status: "conflict", rev: "remote-revision", body: remoteBody }
          : undefined,
      duringIndex: async ({ engine, files }) => {
        files.set("note.md", editedBody);
        await engine.pushPath("note.md");
      },
    });
    await context.engine.pushPath("note.md");
    const copies = [...context.files].filter(([path]) => path !== "note.md");
    assert.equal(copies.length, 1);
    assert.equal(copies[0][1], editedBody);
    assert.equal(context.requests.find((input) => input.path === copies[0][0]).body, editedBody);
    assert.equal(context.files.get("note.md"), remoteBody);
    assert.equal(context.engine.isApplying("note.md"), false);
  });
}

for (const timing of ["index", "retry", "save"]) {
  test(`マージ ${timing} 中の編集を成功した再送後に最新 revision で送る`, async () => {
    const editedBody = "local\nremote\n編集中の追記\n";
    const edit = async ({ engine, files }) => {
      files.set("note.md", editedBody);
      await engine.pushPath("note.md");
    };
    const context = fixture({
      [{ index: "duringIndex", retry: "duringRetry", save: "duringSave" }[timing]]: edit,
    });
    await context.engine.pushPath("note.md");
    assert.deepEqual(
      context.requests.map(({ body }) => body),
      [localBody, mergedBody, editedBody],
    );
    assert.equal(context.requests[2].baseRev, "merged-revision");
    assert.deepEqual([...context.files], [["note.md", editedBody]]);
    assert.equal(context.engine.isApplying("note.md"), false);
  });
}

test("競合コピーの送信中に加えた編集もリモートの上書き前に退避する", async () => {
  const editedBody = "local\nsecond\nコピー待ちの追記\n";
  const context = fixture({
    automaticMerge: false,
    duringCopyPush: async ({ engine, files }) => {
      files.set("note.md", editedBody);
      await engine.pushPath("note.md");
    },
  });
  await context.engine.pushPath("note.md");
  assert.equal(context.files.get("note.md"), remoteBody);
  assert.ok([...context.files.values()].includes(editedBody));
  assert.equal(context.requests.at(-1).body, editedBody);
});

test("競合コピー後の状態保存中の編集も applying 解除後に再送する", async () => {
  const editedBody = "first\nremote\n保存中の追記\n";
  const context = fixture({
    automaticMerge: false,
    duringSave: async ({ engine, files }) => {
      files.set("note.md", editedBody);
      await engine.pushPath("note.md");
    },
  });
  await context.engine.pushPath("note.md");
  assert.equal(context.requests.at(-1).path, "note.md");
  assert.equal(context.requests.at(-1).body, editedBody);
  assert.equal(context.requests.at(-1).baseRev, "remote-revision");
  assert.equal(context.files.get("note.md"), editedBody);
});

for (const [name, configuration] of [
  ["同一行の競合", { outcome: { baseBody: "old\nsecond\n", body: "remote\nsecond\n" } }],
  ["baseBody の欠損", { outcome: { baseBody: undefined } }],
  ["自動マージ無効", { automaticMerge: false }],
  ["exact-body index の欠損", { missingIndex: true }],
  ["index 待機契約の未実装", { missingMethod: true }],
  ["マージ書き込みの例外", { writeThrows: true }],
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

test("編集と削除の競合は原文の退避後に原本を保持して再送する", async () => {
  const context = fixture({ outcome: { body: null } });
  await context.engine.pushPath("note.md");
  assert.equal(context.requests.filter((request) => request.path === "note.md").length, 2);
  assertFallback(context, null);
});

for (const body of ["newest remote body\n", null]) {
  test(`再競合時は最新のリモート${body === null ? "削除に対し原本を再送" : "本文を適用"}する`, async () => {
    const context = fixture({
      retryOutcome: { status: "conflict", rev: "newest-revision", body, baseBody: remoteBody },
    });
    await context.engine.pushPath("note.md");
    assert.equal(
      context.requests.filter((request) => request.path === "note.md").length,
      body === null ? 3 : 2,
    );
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

for (const [mergeFailure, mergeConfiguration] of [
  ["index 欠損", { missingIndex: true }],
  ["再送例外", { retryThrows: true }],
]) {
  for (const [copyFailure, copyConfiguration] of [
    ["コピー書き込み例外", { copyWriteThrows: true }],
    ["コピー送信例外", { copyPushThrows: true }],
  ]) {
    test(`マージ書き込み後の${mergeFailure}と${copyFailure}でも元の本文を原本へ戻す`, async () => {
      const context = fixture({ ...mergeConfiguration, ...copyConfiguration });
      await assert.rejects(context.engine.pushPath("note.md"), /copy .* failed/);
      assert.ok(context.operations.includes("write merged body"));
      assert.equal(context.files.get("note.md"), localBody);
      assert.equal(context.state.revOf("note.md"), "base-revision");
      assert.equal(context.operations.includes("remove original"), false);
      assert.ok(
        context.writes
          .filter((write) => write.path === "note.md")
          .every((write) => write.body === localBody),
      );
      assert.equal(context.engine.isApplying("note.md"), false);
    });
  }
}

for (const body of [remoteBody, null]) {
  test(`コピー送信が競合したら原本へのリモート${body === null ? "削除" : "本文適用"}を中止する`, async () => {
    const context = fixture({ outcome: { body }, missingIndex: true, copyPushConflicts: true });
    await assert.rejects(context.engine.pushPath("note.md"), /conflict/i);
    assert.equal(context.files.get("note.md"), localBody);
    assert.equal(context.state.revOf("note.md"), "base-revision");
    assert.equal(context.operations.includes("remove original"), false);
    assert.ok(
      context.writes
        .filter((write) => write.path === "note.md")
        .every((write) => write.body === localBody),
    );
    assert.equal(context.engine.isApplying("note.md"), false);
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

test("競合コピーの空きパス確認後に作られたファイルを上書きしない", async () => {
  const context = fixture({
    automaticMerge: false,
    duringExists: ({ path, files }) => {
      if (path !== "note.md") files.set(path, "new note at the copy path");
    },
  });
  await assert.rejects(context.engine.pushPath("note.md"), /already exists/);
  assert.equal(context.files.get("note.md"), localBody);
  assert.ok([...context.files.values()].includes("new note at the copy path"));
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
