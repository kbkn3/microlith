import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, debounce } from "obsidian";
import { MicrolithClient, type NoteIndex } from "./client";
import { SyncEngine, type VaultAdapter } from "./sync";
import { PluginState, type PersistedState } from "./state";

type Configuration = {
  endpoint: string;
  vaultId: string;
  token: string;
  deviceName: string;
  syncAllFileTypes: boolean;
};

type StoredData = Configuration & { state?: PersistedState };

const DEFAULT_CONFIGURATION: Configuration = {
  endpoint: "",
  vaultId: "default",
  token: "",
  deviceName: "device",
  syncAllFileTypes: false
};

/** 再接続の間隔。落ちたサーバに詰め寄らないよう指数的に伸ばす。 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export default class MicrolithPlugin extends Plugin {
  private configuration: Configuration = { ...DEFAULT_CONFIGURATION };
  private engine: SyncEngine | null = null;
  private socket: WebSocket | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private stopping = false;

  async onload(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<StoredData>;
    this.configuration = { ...DEFAULT_CONFIGURATION, ...stored };
    this.addSettingTab(new MicrolithSettingTab(this.app, this));

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow()
    });

    // Vault のイベントは起動時のインデックス構築でも大量に飛ぶ。
    // レイアウトが落ち着いてから購読しないと、起動のたびに全ファイルを push してしまう。
    this.app.workspace.onLayoutReady(() => void this.start());
  }

  onunload(): void {
    this.stopping = true;
    this.socket?.close();
  }

  private async start(): Promise<void> {
    if (!this.configuration.endpoint || !this.configuration.token) {
      new Notice("Microlith: set the server URL and device token in settings.");
      return;
    }
    const stored = ((await this.loadData()) ?? {}) as Partial<StoredData>;
    const state = new PluginState(stored.state ?? null, async (next) => {
      await this.saveData({ ...this.configuration, state: next });
    });
    const client = new MicrolithClient(this.configuration.endpoint, this.configuration.vaultId, this.configuration.token);
    this.engine = new SyncEngine(client, this.adapter(), state, {
      deviceName: this.configuration.deviceName,
      syncAllFileTypes: this.configuration.syncAllFileTypes,
      onNotice: (message) => new Notice(`Microlith: ${message}`)
    });

    this.registerVaultEvents();
    this.connect(client);
    await this.syncNow();
  }

  private registerVaultEvents(): void {
    const push = debounce((path: string) => void this.pushSafely(path), 800, true);
    this.registerEvent(this.app.vault.on("modify", (file) => push(file.path)));
    this.registerEvent(this.app.vault.on("create", (file) => push(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => push(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      // rename は「旧 path の削除 + 新 path の作成」として送る。
      // サーバ側に rename の概念を持ち込むと、競合の場合分けが一気に増える。
      push(oldPath);
      push(file.path);
    }));
  }

  private connect(client: MicrolithClient): void {
    if (this.stopping) return;
    const socket = client.connect(() => void this.pullSafely());
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectDelay = RECONNECT_BASE_MS;
    });
    socket.addEventListener("close", () => {
      if (this.stopping) return;
      window.setTimeout(() => this.connect(client), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    });
  }

  private async pushSafely(path: string): Promise<void> {
    try {
      await this.engine?.pushPath(path);
    } catch (error) {
      new Notice(`Microlith: failed to sync ${path}. ${error}`);
    }
  }

  private async pullSafely(): Promise<void> {
    try {
      await this.engine?.pull();
    } catch (error) {
      new Notice(`Microlith: failed to pull changes. ${error}`);
    }
  }

  async syncNow(): Promise<void> {
    await this.pullSafely();
    try {
      await this.engine?.pushAll();
    } catch (error) {
      new Notice(`Microlith: failed to push local changes. ${error}`);
    }
  }

  async updateConfiguration(patch: Partial<Configuration>): Promise<void> {
    this.configuration = { ...this.configuration, ...patch };
    const stored = ((await this.loadData()) ?? {}) as Partial<StoredData>;
    await this.saveData({ ...this.configuration, state: stored.state });
  }

  getConfiguration(): Configuration {
    return this.configuration;
  }

  private adapter(): VaultAdapter {
    const { vault, metadataCache } = this.app;
    const fileAt = (path: string): TFile | null => {
      const file = vault.getAbstractFileByPath(path);
      return file instanceof TFile ? file : null;
    };

    return {
      list: async () => vault.getFiles().map((file) => file.path),
      read: async (path) => {
        const file = fileAt(path);
        if (!file) throw new Error(`missing ${path}`);
        return vault.read(file);
      },
      readBinary: async (path) => {
        const file = fileAt(path);
        if (!file) throw new Error(`missing ${path}`);
        return vault.readBinary(file);
      },
      write: async (path, body) => {
        const file = fileAt(path);
        if (file) await vault.modify(file, body);
        else await vault.create(path, body);
      },
      writeBinary: async (path, data) => {
        const file = fileAt(path);
        if (file) await vault.modifyBinary(file, data);
        else await vault.createBinary(path, data);
      },
      remove: async (path) => {
        const file = fileAt(path);
        // ゴミ箱に入れる。同期の取り違えで消えたときに取り返せる余地を残す。
        if (file) await this.app.fileManager.trashFile(file);
      },
      exists: async (path) => fileAt(path) !== null,
      mtime: async (path) => fileAt(path)?.stat.mtime ?? Date.now(),
      indexOf: (path) => {
        const file = fileAt(path);
        if (!file) return null;
        const cache = metadataCache.getFileCache(file);
        if (!cache) return null;
        // Obsidian のリンク解決仕様(basename 最短一致・エイリアス・見出し参照)に合わせるには、
        // ここで解決済みのものを送るしかない。サーバ側で再実装しない(§2-5)。
        const index: NoteIndex = {
          links: [
            ...(cache.links ?? []).map((link) => ({
              dst: metadataCache.getFirstLinkpathDest(link.link.split("#")[0], path)?.path ?? link.link,
              kind: "wikilink"
            })),
            ...(cache.embeds ?? []).map((embed) => ({
              dst: metadataCache.getFirstLinkpathDest(embed.link.split("#")[0], path)?.path ?? embed.link,
              kind: "embed"
            }))
          ],
          tags: (cache.tags ?? []).map((tag) => tag.tag.replace(/^#/, "")),
          headings: (cache.headings ?? []).map((heading) => ({
            level: heading.level,
            text: heading.heading,
            line: heading.position.start.line,
            parentLine: 0
          })),
          frontmatter: cache.frontmatter ?? null
        };
        return index;
      }
    };
  }
}

class MicrolithSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MicrolithPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const configuration = this.plugin.getConfiguration();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("The Worker you deployed, for example https://microlith.example.workers.dev")
      .addText((text) => text
        .setValue(configuration.endpoint)
        .onChange((value) => void this.plugin.updateConfiguration({ endpoint: value.trim() })));

    new Setting(containerEl)
      .setName("Vault ID")
      .addText((text) => text
        .setValue(configuration.vaultId)
        .onChange((value) => void this.plugin.updateConfiguration({ vaultId: value.trim() })));

    new Setting(containerEl)
      .setName("Device token")
      .setDesc("Issued on the setup page of your Worker.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(configuration.token)
          .onChange((value) => void this.plugin.updateConfiguration({ token: value.trim() }));
      });

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Used in the name of conflict copies.")
      .addText((text) => text
        .setValue(configuration.deviceName)
        .onChange((value) => void this.plugin.updateConfiguration({ deviceName: value.trim() })));

    new Setting(containerEl)
      .setName("Sync all file types")
      .setDesc("Images, audio, video and PDFs are excluded by default, matching Obsidian Sync.")
      .addToggle((toggle) => toggle
        .setValue(configuration.syncAllFileTypes)
        .onChange((value) => void this.plugin.updateConfiguration({ syncAllFileTypes: value })));

    new Setting(containerEl)
      .addButton((button) => button
        .setButtonText("Sync now")
        .setCta()
        .onClick(() => void this.plugin.syncNow()));
  }
}
