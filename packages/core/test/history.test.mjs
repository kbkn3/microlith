import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vite-plus/test";
import { HISTORY_RETENTION_MS } from "../src/schema.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(context, environment) {
      this.ctx = context;
      this.env = environment;
    }
  },
}));

vi.mock("@cloudflare/workers-oauth-provider", () => ({ default: class {} }));

const { VaultDO } = await import("../src/vault.ts");
const { app } = await import("../src/index.ts");

afterEach(() => vi.restoreAllMocks());

async function createVault(database = new DatabaseSync(":memory:")) {
  let transactionDepth = 0;
  let requireTransaction = false;
  let initialization = Promise.resolve();
  const sql = {
    exec(statement, ...values) {
      const normalized = statement.replaceAll(/\s+/g, " ").trim().toUpperCase();
      const isVersionWrite = /^INSERT(?: OR IGNORE)? INTO VERSIONS/.test(normalized);
      const isCurrentStateWrite =
        /^(?:INSERT INTO (?:FILES|NOTES|NOTES_FTS|LINKS|TAGS|HEADINGS)|UPDATE NOTES|DELETE FROM (?:LINKS|TAGS|HEADINGS))/.test(
          normalized,
        );
      const isSequenceWrite = normalized.startsWith("INSERT INTO META") && values[0] === "seq";
      if (
        requireTransaction &&
        transactionDepth === 0 &&
        (isVersionWrite || isCurrentStateWrite || isSequenceWrite)
      ) {
        throw new Error("accepted revisions must be stored atomically");
      }
      return database.prepare(statement).all(...values);
    },
  };
  const context = {
    blockConcurrencyWhile(callback) {
      initialization = callback();
      return initialization;
    },
    storage: {
      sql,
      async deleteAll() {
        const tables = database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();
        for (const { name } of tables) database.exec(`DROP TABLE IF EXISTS "${name}"`);
      },
      transactionSync(callback) {
        database.exec("BEGIN");
        transactionDepth++;
        try {
          const result = callback();
          database.exec("COMMIT");
          return result;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        } finally {
          transactionDepth--;
        }
      },
    },
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
  };
  globalThis.WebSocketRequestResponsePair ??= class {};
  const vault = new VaultDO(context, { ADMIN_SECRET: "test-secret" });
  await initialization;
  requireTransaction = true;
  return { vault, database };
}

test("VaultDO stores accepted revisions atomically and excludes tombstones", async () => {
  const { vault } = await createVault();
  const first = await vault.push({
    path: "note.md",
    baseRev: null,
    kind: "note",
    mtime: 100,
    body: "first",
  });
  assert.equal(first.status, "ok");
  const second = await vault.push({
    path: "note.md",
    baseRev: first.rev,
    kind: "note",
    mtime: 200,
    body: "second",
  });
  assert.equal(second.status, "ok");

  assert.deepEqual(
    (await vault.versions("note.md")).map(({ rev, seq }) => ({ rev, seq })),
    [
      { rev: second.rev, seq: 2 },
      { rev: first.rev, seq: 1 },
    ],
  );
  const savedFirst = await vault.version("note.md", first.rev);
  assert.ok(savedFirst);
  assert.equal(savedFirst.body, "first");
  assert.equal(savedFirst.size, 5);
  assert.equal(savedFirst.mtime, 100);
  assert.equal(savedFirst.seq, 1);
  assert.equal(typeof savedFirst.created_at, "number");
  assert.equal(await vault.version("note.md", "missing"), null);

  const removed = await vault.push({
    path: "note.md",
    baseRev: second.rev,
    kind: "note",
    mtime: 300,
    deleted: true,
  });
  assert.equal(removed.status, "ok");
  assert.equal((await vault.versions("note.md")).length, 2);
});

for (const kind of ["note", "asset"]) {
  test(`legacy deleted ${kind} backfill never uses the tombstone as a content revision`, async () => {
    const { vault, database } = await createVault();
    const path = kind === "note" ? "legacy.md" : "image.png";
    const accepted = await vault.push({
      path,
      kind,
      baseRev: null,
      mtime: 1,
      body: "残す本文\n",
      rev: "asset-revision",
      size: 5,
    });
    const removed = await vault.push({
      path,
      kind,
      baseRev: accepted.rev,
      mtime: 2,
      deleted: true,
    });
    database.exec("DROP TABLE versions; DELETE FROM meta WHERE key = 'history_backfilled_at'");
    const migrated = (await createVault(database)).vault;
    assert.equal(await migrated.version(path, removed.rev), null);
    if (kind === "note") {
      const version = await migrated.version(path, accepted.rev);
      assert.equal(version.body, "残す本文\n");
      assert.equal(version.size, 5);
      assert.equal((await (await createVault(database)).vault.versions(path)).length, 1);
      assert.equal((await migrated.restoreVersion(path, accepted.rev)).rev, accepted.rev);
      assert.equal((await migrated.readNote(path)).body, "残す本文\n");
    } else {
      assert.deepEqual(await migrated.versions(path), []);
    }
  });
}

test("legacy backfill retains current content at the cutoff and skips older rows", async () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const { vault, database } = await createVault();
  const note = await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: null,
    mtime: 1,
    body: "note",
  });
  const asset = await vault.push({
    path: "image.png",
    kind: "asset",
    baseRev: null,
    mtime: 2,
    rev: "asset-revision",
    size: 4,
  });
  await vault.push({ path: "expired.md", kind: "note", baseRev: null, mtime: 3, body: "expired" });
  database
    .prepare("UPDATE files SET updated_at = ? WHERE path = ?")
    .run(now - HISTORY_RETENTION_MS, "note.md");
  database
    .prepare("UPDATE files SET updated_at = ? WHERE path = ?")
    .run(now - HISTORY_RETENTION_MS - 1, "expired.md");
  database.exec("DROP TABLE versions; DELETE FROM meta WHERE key = 'history_backfilled_at'");
  const migrated = (await createVault(database)).vault;
  assert.equal((await migrated.version("note.md", note.rev)).body, "note");
  assert.equal((await migrated.versions("note.md")).length, 1);
  assert.equal((await migrated.version("image.png", asset.rev)).body, null);
  assert.deepEqual(await migrated.versions("expired.md"), []);
  assert.equal((await migrated.readNote("expired.md")).body, "expired");
  assert.equal((await (await createVault(database)).vault.versions("note.md")).length, 1);
});

test("failed legacy hash backfill leaves the completion marker absent for a retry", async () => {
  const { vault, database } = await createVault();
  const note = await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: null,
    mtime: 1,
    body: "retained",
  });
  await vault.push({ path: "note.md", kind: "note", baseRev: note.rev, mtime: 2, deleted: true });
  database.exec("DROP TABLE versions; DELETE FROM meta WHERE key = 'history_backfilled_at'");
  const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("hash failed"));
  await assert.rejects(createVault(database), /hash failed/);
  assert.equal(
    database.prepare("SELECT value FROM meta WHERE key = 'history_backfilled_at'").get(),
    undefined,
  );
  digest.mockRestore();
  const migrated = (await createVault(database)).vault;
  assert.equal((await migrated.version("note.md", note.rev)).body, "retained");
  assert.ok(database.prepare("SELECT value FROM meta WHERE key = 'history_backfilled_at'").get());
});

test("note history with a mismatched content hash cannot change current state", async () => {
  const { vault, database } = await createVault();
  const first = await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: null,
    mtime: 1,
    body: "first",
  });
  await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: first.rev,
    mtime: 2,
    body: "current",
  });
  database.prepare("UPDATE versions SET body = ? WHERE rev = ?").run("corrupt", first.rev);
  const before = await vault.head("note.md");
  assert.equal(await vault.restoreVersion("note.md", first.rev), null);
  assert.deepEqual(await vault.head("note.md"), before);
  assert.equal((await vault.readNote("note.md")).body, "current");
});

for (const action of ["list", "read", "restore"]) {
  test(`expired history is unavailable to ${action} before the next purge`, async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { vault, database } = await createVault();
    const accepted = await vault.push({
      path: "note.md",
      kind: "note",
      baseRev: null,
      mtime: 1,
      body: "current",
    });
    database.prepare("UPDATE versions SET created_at = ?").run(now - HISTORY_RETENTION_MS - 1);
    const before = await vault.head("note.md");
    if (action === "list") assert.deepEqual(await vault.versions("note.md"), []);
    if (action === "read") assert.equal(await vault.version("note.md", accepted.rev), null);
    if (action === "restore")
      assert.equal(await vault.restoreVersion("note.md", accepted.rev), null);
    assert.deepEqual(await vault.head("note.md"), before);
    assert.equal((await vault.readNote("note.md")).body, "current");
  });
}

for (const deleted of [false, true]) {
  test(`purge followed by reinitialization does not resurrect expired ${deleted ? "deleted" : "current"} history`, async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { vault, database } = await createVault();
    const accepted = await vault.push({
      path: "old.md",
      kind: "note",
      baseRev: null,
      mtime: 1,
      body: "current",
    });
    clock.mockReturnValue(now + HISTORY_RETENTION_MS + 1);
    await vault.push(
      deleted
        ? { path: "old.md", kind: "note", baseRev: accepted.rev, mtime: 2, deleted: true }
        : { path: "new.md", kind: "note", baseRev: null, mtime: 2, body: "new" },
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM versions WHERE path = ?").get("old.md").count,
      0,
    );
    const migrated = (await createVault(database)).vault;
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM versions WHERE path = ?").get("old.md").count,
      0,
    );
    if (deleted) {
      assert.equal(await migrated.readNote("old.md"), null);
      assert.equal((await migrated.restore("old.md")).rev, accepted.rev);
    } else {
      assert.deepEqual(
        { ...(await migrated.readNote("old.md")) },
        { rev: accepted.rev, body: "current" },
      );
    }
  });
}

test("a reused destroyed vault does not backfill expired deleted history on restart", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const { vault, database } = await createVault();
  await vault.destroy();
  const accepted = await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: null,
    mtime: 1,
    body: "retained",
  });
  clock.mockReturnValue(now + HISTORY_RETENTION_MS + 1);
  await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: accepted.rev,
    mtime: 2,
    deleted: true,
  });
  const migrated = (await createVault(database)).vault;
  assert.deepEqual(await migrated.versions("note.md"), []);
  assert.equal((await migrated.restore("note.md")).rev, accepted.rev);
});

test("returning to an earlier body refreshes its history entry so purge keeps it", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const { vault } = await createVault();
  const first = await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: null,
    mtime: 1,
    body: "A",
  });
  const second = await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: first.rev,
    mtime: 2,
    body: "B",
  });
  clock.mockReturnValue(now + HISTORY_RETENTION_MS - 1);
  const returned = await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: second.rev,
    mtime: 3,
    body: "A",
  });
  assert.equal(returned.rev, first.rev);
  assert.deepEqual(
    (await vault.versions("note.md")).map(({ rev, seq }) => ({ rev, seq })),
    [
      { rev: returned.rev, seq: 3 },
      { rev: second.rev, seq: 2 },
    ],
  );
  clock.mockReturnValue(now + HISTORY_RETENTION_MS + 1);
  await vault.push({ path: "other.md", kind: "note", baseRev: null, mtime: 4, body: "purge" });
  assert.deepEqual(
    (await vault.versions("note.md")).map(({ rev }) => rev),
    [returned.rev],
  );
  assert.equal((await vault.version("note.md", returned.rev))?.body, "A");
});

test("conflict baseBody preserves an empty base and omits an unavailable base", async () => {
  const { vault } = await createVault();
  const empty = await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: null,
    mtime: 1,
    body: "",
  });
  await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: empty.rev,
    mtime: 2,
    body: "current",
  });
  const conflict = await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: empty.rev,
    mtime: 3,
    body: "local",
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.baseBody, "");
  const missing = await vault.push({
    path: "note.md",
    kind: "note",
    baseRev: "unavailable",
    mtime: 3,
    body: "local",
  });
  assert.equal(missing.status, "conflict");
  assert.equal(Object.hasOwn(missing, "baseBody"), false);
});

test("asset history restore leaves the current revision unchanged when its R2 object is absent", async () => {
  const current = { rev: "current-revision" };
  const headCalls = [];
  let restoreCalls = 0;
  const response = await app.fetch(
    new Request("https://example.test/vault/test/restore?path=image.png&rev=retained-revision", {
      method: "POST",
      headers: { Authorization: "Bearer admin-secret" },
    }),
    {
      ADMIN_SECRET: "admin-secret",
      VAULT: {
        getByName: () => ({
          version: async () => ({
            path: "image.png",
            rev: "retained-revision",
            kind: "asset",
            body: null,
            size: 4,
            mtime: 1,
            seq: 1,
            created_at: 1,
          }),
          restoreVersion: async () => {
            restoreCalls++;
            current.rev = "changed-revision";
            return { status: "ok", seq: 2, rev: current.rev };
          },
        }),
      },
      ASSETS: {
        head: async (key) => {
          headCalls.push(key);
          return null;
        },
      },
    },
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "object missing" });
  assert.deepEqual(headCalls, ["assets/retained-revision"]);
  assert.equal(restoreCalls, 0, "R2 object が無いのに復元処理へ進んでいる");
  assert.equal(current.rev, "current-revision", "R2 object が無いのに current revision が変わった");
});
