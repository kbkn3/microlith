/**
 * 同期エンジンを Obsidian なしで実サーバと突き合わせる。
 * VaultAdapter を挟んでいるのは、まさにこれを可能にするため。
 * `npm run dev` の隣で `npm run test:blade` を実行する。
 */
import assert from "node:assert/strict";
import { MicrolithClient } from "../src/client.ts";
import { SyncEngine, conflictCopyPath, isExcluded } from "../src/sync.ts";

const base = process.env.MICROLITH_URL ?? "http://localhost:8787";
const admin = process.env.ADMIN_SECRET ?? "local-development-admin-secret";
const vaultId = `blade-${Date.now()}`;

// --- 純粋な部分 --------------------------------------------------------------

assert.equal(isExcluded("note.md"), false);
assert.equal(isExcluded("img/a.png"), true, "画像は既定で除外(Obsidian Sync に合わせる)");
assert.equal(isExcluded("img/a.png", true), false, "syncAllFileTypes で拾えるべき");
assert.equal(isExcluded(".obsidian/app.json"), true, "v1 は .obsidian 非対応");
assert.equal(
  conflictCopyPath("notes/a.md", "laptop", new Date(2026, 8, 4, 9, 5)),
  "notes/a (Conflicted copy laptop 202609040905).md"
);

// --- インメモリの Vault -------------------------------------------------------

const makeVault = () => {
  const files = new Map();
  return {
    files,
    list: async () => [...files.keys()],
    read: async (path) => {
      const entry = files.get(path);
      if (typeof entry !== "string") throw new Error(`missing ${path}`);
      return entry;
    },
    readBinary: async (path) => files.get(path),
    write: async (path, body) => void files.set(path, body),
    writeBinary: async (path, data) => void files.set(path, data),
    remove: async (path) => void files.delete(path),
    exists: async (path) => files.has(path),
    mtime: async () => Date.now(),
    indexOf: () => ({ links: [], tags: [], headings: [] })
  };
};

const makeState = () => {
  const revs = new Map();
  return {
    lastSeq: 0,
    revOf: (path) => revs.get(path) ?? null,
    setRev: (path, rev) => void (rev === null ? revs.delete(path) : revs.set(path, rev)),
    paths: () => [...revs.keys()],
    clear() { this.lastSeq = 0; revs.clear(); },
    save: async () => {}
  };
};

const issueToken = async (name) => {
  const response = await fetch(`${base}/vault/${vaultId}/devices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  return (await response.json()).token;
};

const makeDevice = async (name) => {
  const client = new MicrolithClient(base, vaultId, await issueToken(name));
  const vault = makeVault();
  const state = makeState();
  return { vault, state, engine: new SyncEngine(client, vault, state, { deviceName: name }) };
};

// --- 2端末の往復 ---------------------------------------------------------------

const laptop = await makeDevice("laptop");
const phone = await makeDevice("phone");

await laptop.vault.write("note.md", "# 細石刃\n\n最初の版。\n");
await laptop.engine.pushAll();

await phone.engine.pull();
assert.equal(phone.vault.files.get("note.md"), "# 細石刃\n\n最初の版。\n", "他端末に届いていない");

// 受け取った内容をそのまま押し返しても、rev が content hash なので no-op になる
const seqBefore = phone.state.lastSeq;
await phone.engine.pushAll();
await laptop.engine.pull();
assert.equal(phone.state.lastSeq, seqBefore, "受信内容の押し返しで seq が進んでいる(往復が止まらない)");

// --- 競合 ---------------------------------------------------------------------

await laptop.vault.write("note.md", "# 細石刃\n\nラップトップの編集。\n");
await laptop.engine.pushPath("note.md");

await phone.vault.write("note.md", "# 細石刃\n\n電話の編集。\n");
await phone.engine.pushPath("note.md");

assert.equal(phone.vault.files.get("note.md"), "# 細石刃\n\nラップトップの編集。\n",
  "原本にリモート版が入っていない(Obsidian Sync の挙動と違う)");
const copies = [...phone.vault.files.keys()].filter((path) => path.includes("Conflicted copy"));
assert.equal(copies.length, 1, "競合コピーが作られていない");
assert.equal(phone.vault.files.get(copies[0]), "# 細石刃\n\n電話の編集。\n", "自分の版が失われている");

// 競合コピーもサーバに載り、他端末へ流れる
await laptop.engine.pull();
assert.ok(laptop.vault.files.has(copies[0]), "競合コピーが他端末に届いていない");

// --- 削除 ---------------------------------------------------------------------

await laptop.vault.remove("note.md");
await laptop.engine.pushPath("note.md");
await phone.engine.pull();
assert.equal(phone.vault.files.has("note.md"), false, "削除が伝播していない");

// --- 除外 ---------------------------------------------------------------------

await laptop.vault.writeBinary("img/a.png", new Uint8Array([1, 2, 3]).buffer);
await laptop.engine.pushAll();
await phone.engine.pull();
assert.equal(phone.vault.files.has("img/a.png"), false, "既定で除外されるはずの画像が同期された");

console.log(`blade: ok (vault=${vaultId})`);
