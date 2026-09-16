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
    requestUrl: () => {
      throw new Error("not used");
    },
  };
});

const { default: MicrolithPlugin } = await import("../src/main.ts");
const { TFile } = await import("obsidian");

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.window;
});

function makePlugin(modify) {
  const file = new TFile("note.md");
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
    getAbstractFileByPath: (path) => (path === file.path ? file : null),
    modify: (target, body) => {
      operations.push("write");
      return modify({
        target,
        body,
        emit: (...arguments_) => changed?.(...arguments_),
      });
    },
  };
  const plugin = new MicrolithPlugin({
    vault,
    metadataCache,
    workspace: { onLayoutReady() {} },
    fileManager: {},
  });
  return {
    adapter: plugin.adapter(),
    emitRegistered: (...arguments_) => registeredChanged?.(...arguments_),
    file,
    metadataCache,
    operations,
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

  assert.deepEqual(await adapter.writeAndWaitForIndex("note.md", "wanted"), {
    links: [],
    tags: ["correct"],
    headings: [],
    frontmatter: null,
  });
  assert.deepEqual(operations, ["subscribe", "write"]);
  assert.equal(metadataCache.offrefCount, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("write failure cleans up and rethrows", async () => {
  vi.useFakeTimers();
  globalThis.window = globalThis;
  const { adapter, metadataCache } = makePlugin(() => {
    throw new Error("disk failed");
  });

  await assert.rejects(adapter.writeAndWaitForIndex("note.md", "wanted"), /disk failed/);
  assert.equal(metadataCache.offrefCount, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("five-second timeout cleans up and returns null", async () => {
  vi.useFakeTimers();
  globalThis.window = globalThis;
  const { adapter, metadataCache } = makePlugin(() => {});

  const pending = adapter.writeAndWaitForIndex("note.md", "wanted");
  await vi.advanceTimersByTimeAsync(4_999);
  assert.equal(metadataCache.offrefCount, 0);
  await vi.advanceTimersByTimeAsync(1);

  assert.equal(await pending, null);
  assert.equal(metadataCache.offrefCount, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("late callbacks do not clean up twice", async () => {
  vi.useFakeTimers();
  globalThis.window = globalThis;
  const { adapter, emitRegistered, file, metadataCache } = makePlugin(({ body, emit }) => {
    emit(file, body, {});
  });

  await adapter.writeAndWaitForIndex("note.md", "wanted");
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
