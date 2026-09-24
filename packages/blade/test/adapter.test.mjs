import assert from "node:assert/strict";
import { afterEach, test, vi } from "vite-plus/test";

vi.mock("obsidian", () => {
  class Plugin {
    constructor(app) {
      this.app = app;
    }

    addCommand() {}
    addSettingTab() {}
    loadData() {
      return Promise.resolve(this.storedData);
    }

    async saveData(data) {
      this.storedData = data;
    }
  }

  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
    }
  }

  class TFile {
    constructor(path) {
      this.path = path;
      this.stat = { mtime: 0 };
    }
  }

  return {
    Notice: class {},
    Plugin,
    PluginSettingTab,
    Setting: class {},
    TFile,
    debounce: (callback) => callback,
    requestUrl: vi.fn(() => {
      throw new Error("not used");
    }),
  };
});

const { default: MicrolithPlugin } = await import("../src/main.ts");
const { TFile, requestUrl } = await import("obsidian");

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  delete globalThis.window;
});

function makePlugin(modify, initialBody = "") {
  const file = new TFile("note.md");
  const copies = new Map();
  let storedBody = initialBody;
  const operations = [];
  let changed;
  let registeredChanged;
  let reference;
  const metadataCache = {
    offrefCount: 0,
    on: (_name, callback) => {
      operations.push("subscribe");
      changed = callback;
      registeredChanged = callback;
      reference = {};
      return reference;
    },
    offref: (removedReference) => {
      assert.equal(removedReference, reference);
      metadataCache.offrefCount += 1;
      changed = undefined;
    },
    getFileCache: () => null,
    getFirstLinkpathDest: () => null,
  };
  const vault = {
    getAbstractFileByPath: (path) =>
      path === file.path ? file : copies.has(path) ? new TFile(path) : null,
    read: async (target) => (target.path === file.path ? storedBody : copies.get(target.path)),
    create: async (path, body) => {
      if (path === file.path || copies.has(path)) throw new Error("file already exists");
      copies.set(path, body);
      return new TFile(path);
    },
    modify: (target, body) => {
      operations.push("write");
      storedBody = body;
      return modify({
        target,
        body,
        emit: (...arguments_) => changed?.(...arguments_),
      });
    },
    process: async (target, transform) => {
      const body = transform(storedBody);
      await vault.modify(target, body);
      return body;
    },
  };
  const plugin = new MicrolithPlugin({
    vault,
    metadataCache,
    workspace: { onLayoutReady() {} },
    fileManager: {},
  });
  return {
    plugin,
    copies,
    adapter: plugin.adapter(),
    emitRegistered: (...arguments_) => registeredChanged?.(...arguments_),
    file,
    metadataCache,
    operations,
    read: () => storedBody,
  };
}

test("waits for the exact path and body after subscribing", async () => {
  vi.useFakeTimers();
  globalThis.window = globalThis;
  const { adapter, file, metadataCache, operations } = makePlugin(({ body, emit }) => {
    emit(new TFile("other.md"), body, { tags: [{ tag: "#wrong-path" }] });
    emit(file, "other body", { tags: [{ tag: "#wrong-body" }] });
    emit(file, body, { tags: [{ tag: "#correct" }] });
  });

  assert.deepEqual(await adapter.writeAndWaitForIndex("note.md", "wanted", ""), {
    applied: true,
    index: {
      links: [],
      tags: ["correct"],
      headings: [],
      frontmatter: null,
    },
  });
  assert.deepEqual(operations, ["subscribe", "write"]);
  assert.equal(metadataCache.offrefCount, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("atomic replacement preserves edits made after the expected snapshot", async () => {
  const { adapter, read } = makePlugin(() => {}, "new user edit");
  assert.equal(await adapter.replaceIfUnchanged("note.md", "old snapshot", "remote"), false);
  assert.equal(read(), "new user edit");
  assert.equal(await adapter.replaceIfUnchanged("note.md", "new user edit", "remote"), true);
  assert.equal(read(), "remote");
});

test("a stale merge snapshot cancels the index wait without replacing the edit", async () => {
  vi.useFakeTimers();
  globalThis.window = globalThis;
  const { adapter, read, metadataCache } = makePlugin(() => {}, "new user edit");
  assert.deepEqual(await adapter.writeAndWaitForIndex("note.md", "merged", "old snapshot"), {
    applied: false,
  });
  assert.equal(read(), "new user edit");
  assert.equal(metadataCache.offrefCount, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("write failure cleans up and rethrows", async () => {
  vi.useFakeTimers();
  globalThis.window = globalThis;
  const { adapter, metadataCache } = makePlugin(() => {
    throw new Error("disk failed");
  });

  await assert.rejects(adapter.writeAndWaitForIndex("note.md", "wanted", ""), /disk failed/);
  assert.equal(metadataCache.offrefCount, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("five-second timeout cleans up and returns null", async () => {
  vi.useFakeTimers();
  globalThis.window = globalThis;
  const { adapter, metadataCache } = makePlugin(() => {});

  const pending = adapter.writeAndWaitForIndex("note.md", "wanted", "");
  await vi.advanceTimersByTimeAsync(4_999);
  assert.equal(metadataCache.offrefCount, 0);
  await vi.advanceTimersByTimeAsync(1);

  assert.deepEqual(await pending, { applied: true, index: null });
  assert.equal(metadataCache.offrefCount, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("late callbacks do not clean up twice", async () => {
  vi.useFakeTimers();
  globalThis.window = globalThis;
  const { adapter, emitRegistered, file, metadataCache } = makePlugin(({ body, emit }) => {
    emit(file, body, {});
  });

  await adapter.writeAndWaitForIndex("note.md", "wanted", "");
  emitRegistered(file, "wanted", {});

  assert.equal(metadataCache.offrefCount, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("old stored data keeps automatic merge enabled", async () => {
  const plugin = new MicrolithPlugin({ workspace: { onLayoutReady() {} } });
  plugin.storedData = { endpoint: "", vaultId: "old", token: "", deviceName: "old-device" };

  await plugin.onload();

  assert.equal(plugin.getConfiguration().automaticMerge, true);
});

for (const [timing, automaticMerge] of [
  ["起動後", false],
  ["起動後", true],
  ["起動前", false],
  ["起動前", true],
]) {
  test(`${timing}の automaticMerge=${automaticMerge} が次の競合へ即時反映される`, async () => {
    globalThis.window = globalThis;
    const localBody = "local\nsecond\n";
    const context = makePlugin(({ body, emit }) => emit(context.file, body, {}), localBody);
    const { plugin } = context;
    plugin.storedData = {
      endpoint: "https://example.test",
      token: "test",
      deviceName: "phone",
      automaticMerge: !automaticMerge,
      state: { lastSeq: 4, revs: { "note.md": "base-revision" } },
    };
    await plugin.onload();
    plugin.registerVaultEvents = () => {};
    plugin.connect = () => {};
    plugin.syncNow = async () => {};
    if (timing === "起動後") await plugin.start();
    await plugin.updateConfiguration({ automaticMerge });
    await plugin.updateConfiguration({ deviceName: "updated-device" });
    if (timing === "起動前") await plugin.start();
    const requests = [];
    requestUrl.mockImplementation(async ({ body }) => {
      const input = JSON.parse(body);
      requests.push(input);
      const conflict = requests.length === 1;
      return {
        status: conflict ? 409 : 200,
        headers: {},
        json: conflict
          ? {
              status: "conflict",
              rev: "remote-revision",
              body: "first\nremote\n",
              baseBody: "first\nsecond\n",
            }
          : { status: "ok", rev: "accepted-revision", seq: 2 },
      };
    });
    await plugin.engine.pushPath("note.md");
    assert.equal(context.read(), automaticMerge ? "local\nremote\n" : "first\nremote\n");
    assert.equal(context.copies.size, automaticMerge ? 0 : 1);
    assert.equal(requests[0].baseRev, "base-revision");
    assert.equal(requests[1].body, automaticMerge ? "local\nremote\n" : localBody);
    assert.equal(plugin.storedData.automaticMerge, automaticMerge);
    assert.equal(plugin.storedData.deviceName, "updated-device");
    assert.equal(plugin.storedData.state.lastSeq, 4);
  });
}
