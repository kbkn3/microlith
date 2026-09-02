/**
 * `npm run dev` を起動した状態で `node packages/core/test/smoke.mjs` を実行する。
 * WebSocket のブロードキャストは発信元除外と auto-response が絡んで自明でないため、
 * ここだけは動かして確かめる。
 */
import assert from "node:assert/strict";

const base = process.env.MICROLITH_URL ?? "http://localhost:8787";
const wsBase = base.replace(/^http/, "ws");

const status = await fetch(`${base}/vault/smoke/status`).then((r) => r.json());
assert.equal(status.files, 0, "新しい Vault は空のはず");
assert.ok(status.tools.includes("vault_tree"), "haft のツール定義が Worker まで届いていない");

const connect = (device) =>
  new Promise((resolve) => {
    const socket = new WebSocket(`${wsBase}/vault/smoke/ws?device=${device}`);
    socket.inbox = [];
    socket.addEventListener("message", (event) => socket.inbox.push(event.data));
    socket.addEventListener("open", () => resolve(socket));
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

const a = await connect("device-a");
const b = await connect("device-b");
await settle();

a.send("changed:seq=1");
await settle();
assert.deepEqual(a.inbox, [], "発信元に echo が返っている");
assert.deepEqual(b.inbox, ["changed:seq=1"], "他端末に通知が届いていない");

// auto-response が効いていないと keepalive のたびに DO が起きて hibernation が無意味になる
b.send("ping");
await settle();
assert.deepEqual(b.inbox.slice(1), ["pong"], "ping/pong の auto-response が効いていない");

a.close();
b.close();
console.log("smoke: ok");
