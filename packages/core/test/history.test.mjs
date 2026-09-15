import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { BACKFILL_VERSIONS_SQL, PURGE_VERSIONS_SQL, SCHEMA } from "../src/schema.ts";

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
