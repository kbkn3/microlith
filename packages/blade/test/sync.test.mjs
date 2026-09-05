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

// --- オフライン中の編集が pull で消えないこと -------------------------------------

// 端末を止めている間に他端末が編集し、再開したときに自分の編集が残っているか。
// pull 側に競合検知が無いと、ここで黙って消える。
await laptop.vault.write("offline.md", "# オフライン検証\n\n共通の出発点。\n");
await laptop.engine.pushPath("offline.md");
await phone.engine.pull();
assert.equal(phone.vault.files.get("offline.md"), "# オフライン検証\n\n共通の出発点。\n");

// phone を止めている間に laptop が編集
await laptop.vault.write("offline.md", "# オフライン検証\n\nラップトップ側の続き。\n");
await laptop.engine.pushPath("offline.md");

// phone は止まったまま自分でも編集(push はしていない)
await phone.vault.write("offline.md", "# オフライン検証\n\n電話側で書いた大事な文章。\n");

// 再開: pull が先に走る
await phone.engine.pull();

const offlineCopies = [...phone.vault.files.keys()]
  .filter((path) => path.startsWith("offline (Conflicted copy"));
assert.equal(offlineCopies.length, 1,
  "オフライン中の編集が競合コピーになっていない(上書きで消えた可能性)");
assert.equal(phone.vault.files.get(offlineCopies[0]), "# オフライン検証\n\n電話側で書いた大事な文章。\n",
  "オフライン中に書いた本文が失われている");
assert.equal(phone.vault.files.get("offline.md"), "# オフライン検証\n\nラップトップ側の続き。\n",
  "原本にリモート版が入っていない");

// --- 同一内容の端末を後から繋いでも競合にならないこと ---------------------------------

// Vault をコピーして別端末に入れた場合。中身が同じなら競合コピーは作らない。
const clone = await makeDevice("clone");
for (const [path, body] of laptop.vault.files) await clone.vault.write(path, body);
await clone.engine.pull();
// 手元と同じ内容なのだから、この端末名の競合コピーは1つも生まれないはず
const madeHere = [...clone.vault.files.keys()].filter((path) => path.includes("Conflicted copy clone"));
assert.deepEqual(madeHere, [], "同一内容なのに競合コピーを作っている");

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
