import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { test } from "vite-plus/test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const version = { rev: "retained", kind: "note", size: 5, created_at: 1 };

function setup() {
  const element = () => ({
    children: [],
    value: "",
    textContent: "",
    hidden: false,
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
  });
  const elements = new Map(
    [...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], element()]),
  );
  const storage = () => {
    const values = new Map();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
  };
  const requests = [];
  const confirmations = [];
  const context = createContext({
    document: { getElementById: (id) => elements.get(id), createElement: element },
    sessionStorage: storage(),
    localStorage: storage(),
    location: { origin: "https://example.test" },
    URL,
    window: {
      confirm: (message) => {
        confirmations.push(message);
        return true;
      },
    },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      const action = url.pathname.split("/").at(-1);
      const body = await fixture.respond(action, url);
      return { ok: true, json: async () => body };
    },
  });
  const fixture = {
    elements,
    requests,
    confirmations,
    respond: (action) =>
      ({
        status: { files: 1, seq: 1, connectedDevices: 0, databaseSize: 0, ftsIntegrity: "ok" },
        devices: { devices: [] },
        grants: { grants: [] },
        deleted: { files: [] },
        vaults: { vaults: [] },
        versions: { versions: [version] },
        version: { ...version, body: "saved" },
        restore: { status: "ok" },
      })[action],
    async connect(vault) {
      elements.get("vault").value = vault;
      elements.get("secret").value = "test-admin";
      await elements.get("connect").onclick();
    },
    load: (path = "note.md") => runInContext(`loadHistory(${JSON.stringify(path)})`, context),
    buttons: (row = 0) => elements.get("history").children[row].children[2].children,
  };
  runInContext(script, context);
  return fixture;
}

test("switching vaults clears history and makes old row actions inert", async () => {
  const fixture = setup();
  await fixture.connect("vault-a");
  await fixture.load();
  const [preview, restore] = fixture.buttons();
  await preview.onclick();
  await fixture.connect("vault-b");
  assert.equal(fixture.elements.get("history").children.length, 0);
  assert.equal(fixture.elements.get("history-preview").hidden, true);
  assert.equal(fixture.elements.get("history-preview").textContent, "");
  const count = fixture.requests.length;
  await preview.onclick();
  await restore.onclick();
  assert.equal(fixture.requests.length, count);
  assert.equal(fixture.confirmations.length, 0);
});

for (const action of ["versions", "version", "restore"]) {
  test(`late ${action} response cannot modify the next vault's history`, async () => {
    const fixture = setup();
    await fixture.connect("vault-a");
    await fixture.load();
    const [preview, restore] = fixture.buttons();
    const pending = Promise.withResolvers();
    const respond = fixture.respond;
    fixture.respond = (requested) => (requested === action ? pending.promise : respond(requested));
    const request =
      action === "versions"
        ? fixture.load()
        : action === "version"
          ? preview.onclick()
          : restore.onclick();
    await fixture.connect("vault-b");
    const count = fixture.requests.length;
    pending.resolve(respond(action));
    await request;
    assert.equal(fixture.requests.length, count);
    assert.equal(fixture.elements.get("history").children.length, 0);
    assert.equal(fixture.elements.get("history-preview").hidden, true);
    assert.equal(fixture.elements.get("connection-note").textContent, "Connected to vault-b.");
  });
}

for (const action of ["versions", "version"]) {
  test(`late ${action} response cannot replace another path in the same vault`, async () => {
    const fixture = setup();
    await fixture.connect("vault-a");
    await fixture.load("a.md");
    const pending = Promise.withResolvers();
    const respond = fixture.respond;
    fixture.respond = (requested, url) =>
      requested === action && url.searchParams.get("path") === "a.md"
        ? pending.promise
        : respond(requested);
    const request = action === "versions" ? fixture.load("a.md") : fixture.buttons()[0].onclick();
    await fixture.load("b.md");
    pending.resolve(action === "versions" ? { versions: [] } : { ...version, body: "a body" });
    await request;
    assert.equal(fixture.elements.get("history").children.length, 1);
    assert.equal(fixture.elements.get("history-preview").hidden, true);
    await fixture.buttons()[1].onclick();
    const restored = fixture.requests.find(({ method }) => method === "POST");
    assert.equal(restored.url.searchParams.get("path"), "b.md");
  });
}

test("late preview cannot replace the latest revision selection", async () => {
  const fixture = setup();
  await fixture.connect("vault-a");
  const pending = Promise.withResolvers();
  const respond = fixture.respond;
  fixture.respond = (action, url) => {
    if (action === "versions") return { versions: [version, { ...version, rev: "newer" }] };
    if (action === "version")
      return url.searchParams.get("rev") === "retained"
        ? pending.promise
        : { ...version, rev: "newer", body: "newer body" };
    return respond(action);
  };
  await fixture.load();
  const first = fixture.buttons()[0].onclick();
  await fixture.buttons(1)[0].onclick();
  pending.resolve({ ...version, body: "older body" });
  await first;
  assert.equal(fixture.elements.get("history-preview").textContent, "newer body");
  assert.equal(fixture.elements.get("history-preview").hidden, false);
});

test("history restore names its vault and keeps the selected path", async () => {
  const fixture = setup();
  await fixture.connect("vault-a");
  await fixture.load();
  fixture.elements.get("history-path").value = "other.md";
  await fixture.buttons()[1].onclick();
  assert.match(fixture.confirmations[0], /vault-a/);
  assert.match(fixture.confirmations[0], /note\.md/);
  const restore = fixture.requests.find(({ method }) => method === "POST");
  assert.equal(restore.url.pathname, "/vault/vault-a/restore");
  assert.equal(restore.url.searchParams.get("path"), "note.md");
  assert.equal(fixture.requests.at(-1).url.searchParams.get("path"), "note.md");
});
