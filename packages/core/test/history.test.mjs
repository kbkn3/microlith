import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test, vi } from "vite-plus/test";
import { BACKFILL_VERSIONS_SQL, PURGE_VERSIONS_SQL, SCHEMA } from "../src/schema.ts";

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

function createVault() {
  const database = new DatabaseSync(":memory:");
  let transactionDepth = 0;
  let requireTransaction = false;
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
      if (values.length === 0) {
        database.exec(statement);
        return [];
      }
      return database.prepare(statement).all(...values);
    },
  };
  const context = {
    storage: {
      sql,
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
  requireTransaction = true;
  return vault;
}

test("version history backfill is idempotent and purge keeps current state", () => {
  const database = new DatabaseSync(":memory:");
  for (const statement of SCHEMA) database.exec(statement);
  database.exec(`
    INSERT INTO notes(id, path, body) VALUES
      (1, 'current.md', 'current'),
      (2, 'deleted.md', 'deleted');
    INSERT INTO files(path, seq, rev, kind, size, mtime, deleted, deleted_at, updated_at) VALUES
      ('current.md', 1, 'note-current', 'note', 7, 100, 0, NULL, 1000),
      ('deleted.md', 2, 'note-deleted', 'note', 7, 200, 1, 1900, 1900),
      ('image.png', 3, 'asset-current', 'asset', 4, 300, 0, NULL, 2000);
  `);
  database.prepare(BACKFILL_VERSIONS_SQL).run(1500);
  database.prepare(BACKFILL_VERSIONS_SQL).run(1500);
  assert.equal(database.prepare("SELECT count(*) AS count FROM versions").get().count, 3);
  assert.equal(
    database.prepare("SELECT body FROM versions WHERE rev = 'note-current'").get().body,
    "current",
  );
  assert.equal(
    database.prepare("SELECT body FROM versions WHERE rev = 'asset-current'").get().body,
    null,
  );
  database.prepare(PURGE_VERSIONS_SQL).run(1500);
  assert.equal(database.prepare("SELECT count(*) AS count FROM versions").get().count, 2);
  assert.equal(database.prepare("SELECT count(*) AS count FROM files").get().count, 3);
});

test("VaultDO stores accepted revisions atomically and excludes tombstones", async () => {
  const vault = createVault();
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
