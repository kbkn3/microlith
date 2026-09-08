import assert from "node:assert/strict";
import { test } from "vitest";
import { knownVaults } from "../src/registry.ts";

test("旧形式の Vault 一覧を単一キーへ移行する", async () => {
  const values = new Map();
  const legacyKeys = [{ name: "vault:second" }, { name: "vault:first" }];
  const environment = {
    OAUTH_KV: {
      async get(key, options) {
        const value = values.get(key);
        if (value === undefined) return null;
        return options?.type === "json" ? JSON.parse(value) : value;
      },
      async list({ prefix }) {
        return { keys: legacyKeys.filter((key) => key.name.startsWith(prefix)) };
      },
      async put(key, value) {
        values.set(key, value);
      },
    },
  };

  const migrated = await knownVaults(environment);

  assert.deepEqual(migrated, ["first", "second"], "旧形式の Vault が一覧から消えた");
  assert.deepEqual(
    JSON.parse(values.get("vaults")),
    ["first", "second"],
    "旧形式の Vault が新しい単一キーへ移行されていない",
  );

  console.log("registry: ok");
});
