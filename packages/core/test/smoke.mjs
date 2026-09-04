/**
 * `npm run dev` を起動した状態で `npm run smoke` を実行する。
 * 同期プロトコルは競合・no-op・tombstone・FTS5 の整合が絡んで自明でないため、
 * フレームワークは入れずにここで一通り動かして確かめる。
 */
import assert from "node:assert/strict";

const base = process.env.MICROLITH_URL ?? "http://localhost:8787";
const wsBase = base.replace(/^http/, "ws");
const admin = process.env.ADMIN_SECRET ?? "local-development-admin-secret";
const vault = `smoke-${Date.now()}`;

const call = async (action, { token, method = "GET", body, query = "" } = {}) => {
  const response = await fetch(`${base}/vault/${vault}/${action}${query}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

// --- 認証 -------------------------------------------------------------------

const anonymous = await call("status", { token: "nope" });
assert.equal(anonymous.status, 401, "未知のトークンが通ってしまう");

const created = await call("devices", { token: admin, method: "POST", body: { name: "laptop" } });
assert.equal(created.status, 201);
const device = created.body.token;
assert.ok(device, "デバイストークンが返っていない");

const readOnly = await call("devices", { token: admin, method: "POST", body: { name: "phone", scope: "mcp-read" } });
const readToken = readOnly.body.token;

// --- push と no-op -----------------------------------------------------------

const note = "# 細石刃\n\n小さな刃を柄に植え込んで一つの道具にする複合具。\n";
const first = await call("push", {
  token: device, method: "POST",
  body: { path: "note.md", baseRev: null, mtime: 1, body: note,
          index: { links: [{ dst: "other.md", kind: "wikilink" }], tags: ["考古"],
                   headings: [{ level: 1, text: "細石刃", line: 0, parentLine: 0 }] } }
});
assert.equal(first.status, 200);
assert.equal(first.body.status, "ok");
assert.equal(first.body.seq, 1);

const again = await call("push", {
  token: device, method: "POST",
  body: { path: "note.md", baseRev: first.body.rev, mtime: 2, body: note }
});
assert.equal(again.body.status, "unchanged", "同内容の書き戻しが no-op になっていない(往復が止まらない)");
assert.equal(again.body.seq, 1, "no-op なのに seq が進んでいる");

// --- 競合 --------------------------------------------------------------------

const stale = await call("push", {
  token: device, method: "POST",
  body: { path: "note.md", baseRev: "0".repeat(64), mtime: 3, body: "別の端末の編集\n" }
});
assert.equal(stale.status, 409, "古い baseRev の push が通ってしまう");
assert.equal(stale.body.body, note, "競合レスポンスに現在の本文が入っていない");

// --- 更新と FTS5 の整合 --------------------------------------------------------

let rev = first.body.rev;
for (let i = 0; i < 5; i++) {
  const updated = await call("push", {
    token: device, method: "POST",
    body: { path: "note.md", baseRev: rev, mtime: 10 + i, body: `${note}追記 ${i}\n` }
  });
  assert.equal(updated.body.status, "ok", `更新 ${i} が通らない`);
  rev = updated.body.rev;
}
const afterUpdates = await call("status", { token: device });
assert.equal(afterUpdates.body.ftsIntegrity, "ok", "FTS5 が壊れている(delete に渡す値がズレている)");

// --- 読み出しと差分 -------------------------------------------------------------

const file = await call("file", { token: device, query: "?path=note.md" });
assert.equal(file.body.rev, rev);
assert.ok(file.body.body.includes("追記 4"));

const changes = await call("changes", { token: device, query: "?since=0" });
assert.equal(changes.body.changes.length, 1, "同じ path は1件に集約されるはず");
assert.equal(changes.body.changes[0].path, "note.md");
assert.equal(changes.body.hasMore, false);

const incremental = await call("changes", { token: device, query: `?since=${changes.body.seq}` });
assert.equal(incremental.body.changes.length, 0, "差分カーソルが効いていない");

// --- 権限 --------------------------------------------------------------------

const rejected = await call("push", {
  token: readToken, method: "POST",
  body: { path: "x.md", baseRev: null, mtime: 1, body: "x" }
});
assert.equal(rejected.status, 403, "read-only トークンで書き込めてしまう");

// --- 削除・復元 ----------------------------------------------------------------

const removed = await call("push", {
  token: device, method: "POST",
  body: { path: "note.md", baseRev: rev, mtime: 20, deleted: true }
});
assert.equal(removed.body.status, "ok");
assert.equal((await call("file", { token: device, query: "?path=note.md" })).status, 404);

const deleted = await call("deleted", { token: device });
assert.equal(deleted.body.files.length, 1, "削除済み一覧に出ていない");

const restored = await call("restore", { token: device, method: "POST", query: "?path=note.md" });
assert.equal(restored.body.status, "ok", "復元できない");
const back = await call("file", { token: device, query: "?path=note.md" });
assert.ok(back.body.body.includes("追記 4"), "復元した本文が違う");

// --- 添付(R2 経由) ----------------------------------------------------------------

const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
const uploaded = await fetch(
  `${base}/vault/${vault}/asset?path=img/a.png&mtime=40`,
  { method: "POST", headers: { Authorization: `Bearer ${device}` }, body: bytes }
).then((r) => r.json());
assert.equal(uploaded.status, "ok", "添付をアップロードできない");

const fetched = await fetch(`${base}/vault/${vault}/file?path=img/a.png`, {
  headers: { Authorization: `Bearer ${device}` }
});
assert.equal(fetched.headers.get("etag"), uploaded.rev, "R2 のキーが content hash になっていない");
assert.deepEqual(new Uint8Array(await fetched.arrayBuffer()), bytes, "添付の中身が壊れている");

// 同じ内容の再送は R2 の同じキーに落ちるので no-op になる
const resent = await fetch(
  `${base}/vault/${vault}/asset?path=img/a.png&mtime=41&baseRev=${uploaded.rev}`,
  { method: "POST", headers: { Authorization: `Bearer ${device}` }, body: bytes }
).then((r) => r.json());
assert.equal(resent.status, "unchanged", "添付の再送が no-op になっていない");

// --- WebSocket 通知 --------------------------------------------------------------

// WebSocket はヘッダを付けられないので、サブプロトコルでトークンを渡す
const connect = (deviceToken) =>
  new Promise((resolve) => {
    const socket = new WebSocket(`${wsBase}/vault/${vault}/ws`, ["bearer", deviceToken]);
    socket.inbox = [];
    socket.addEventListener("message", (event) => socket.inbox.push(event.data));
    socket.addEventListener("open", () => resolve(socket));
  });
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

const a = await connect(device);
const b = await connect(readToken);
await settle();

a.send("relay-check");
await settle();
assert.deepEqual(a.inbox, [], "発信元に echo が返っている");
assert.deepEqual(b.inbox, ["relay-check"], "他端末に中継されていない");

b.send("ping");
await settle();
assert.deepEqual(b.inbox.slice(1), ["pong"], "ping/pong の auto-response が効いていない");

// push は接続中の全端末に通知が飛ぶ
await call("push", {
  token: device, method: "POST",
  body: { path: "second.md", baseRev: null, mtime: 30, body: "# 二枚目\n" }
});
await settle();
const notified = JSON.parse(a.inbox.at(-1));
assert.equal(notified.type, "changed");
assert.ok(notified.seq > 0, "通知に seq が入っていない");

a.close();
b.close();
console.log(`smoke: ok (vault=${vault}, seq=${notified.seq})`);
