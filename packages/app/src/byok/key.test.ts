import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaByokStatus } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  ArenaByokKeyMissingError,
  createArenaByokKey,
  platformArenaByokKeyStorage,
  type ArenaByokClient,
  type ArenaByokKeyStorage,
} from "./key";

const asyncStorage = vi.hoisted(() => new Map<string, string>());

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (name: string) => asyncStorage.get(name) ?? null,
    setItem: async (name: string, value: string) => {
      asyncStorage.set(name, value);
    },
    removeItem: async (name: string) => {
      asyncStorage.delete(name);
    },
  },
}));

function createMemoryStorage(initial: string | null = null) {
  const values = new Map<string, string | null>([
    ["openrouter", initial],
    ["ollama", null],
  ]);
  const storage: ArenaByokKeyStorage = {
    load: async (provider) => values.get(provider) ?? null,
    save: async (provider, next) => {
      values.set(provider, next);
    },
    clear: async (provider) => {
      values.set(provider, null);
    },
  };
  return { storage, stored: () => values.get("openrouter") ?? null };
}

/** Answers like the daemon: only a build without a control plane takes a key. */
function createDaemon(input: {
  byok: boolean;
  key?: string | null;
  provider?: "openrouter" | "ollama";
}) {
  let key = input.key ?? null;
  let providerHeld: "openrouter" | "ollama" = input.provider ?? "openrouter";
  const sent: Array<string | null> = [];
  const handovers: string[] = [];
  const client: ArenaByokClient = {
    arenaByokStatus: async (options = {}): Promise<ArenaByokStatus> => {
      if (options.keyHandover) handovers.push(options.keyHandover);
      const status: ArenaByokStatus = { available: input.byok, configured: key !== null };
      if (key !== null && providerHeld) status.provider = providerHeld;
      return status;
    },
    setArenaByokKey: async (next, provider = "openrouter") => {
      if (!input.byok) throw new Error("This build signs in to Agent Duel");
      sent.push(next);
      key = next;
      providerHeld = provider;
      return { configured: key !== null };
    },
  };
  return { client, sent, handovers, held: () => key };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("delivering the OpenRouter key on connect", () => {
  it("hands the stored key to a daemon that runs Arena on one", async () => {
    const keys = createArenaByokKey(createMemoryStorage("sk-or-stored").storage);
    const daemon = createDaemon({ byok: true });

    await expect(keys.deliver(daemon.client, "openrouter")).resolves.toEqual({
      available: true,
      configured: true,
      provider: "openrouter",
    });
    expect(daemon.held()).toBe("sk-or-stored");
    // Announced first, so the daemon holds Arena starts for the key instead of failing them.
    expect(daemon.handovers).toEqual(["pending"]);
  });

  it("tells a daemon at once that this computer has no key to hand over", async () => {
    const keys = createArenaByokKey(createMemoryStorage().storage);
    const daemon = createDaemon({ byok: true });

    await expect(keys.deliver(daemon.client, "openrouter")).resolves.toEqual({
      available: true,
      configured: false,
    });
    expect(daemon.handovers).toEqual(["pending", "none"]);
    expect(daemon.sent).toEqual([]);
  });

  it("tells the daemon there is no key coming when the stored key cannot be read", async () => {
    const storage: ArenaByokKeyStorage = {
      load: async () => {
        throw new Error("Encrypted BYOK key storage is unavailable");
      },
      save: async () => undefined,
      clear: async () => undefined,
    };
    const keys = createArenaByokKey(storage);
    const daemon = createDaemon({ byok: true });

    await expect(keys.deliver(daemon.client, "openrouter")).rejects.toThrow(
      "storage is unavailable",
    );
    expect(daemon.handovers).toEqual(["pending", "none"]);
  });

  it("sends nothing to a daemon with a control plane", async () => {
    const keys = createArenaByokKey(createMemoryStorage("sk-or-stored").storage);
    const daemon = createDaemon({ byok: false });

    await expect(keys.deliver(daemon.client, "openrouter")).resolves.toEqual({
      available: false,
      configured: false,
    });
    expect(daemon.sent).toEqual([]);
  });

  it("leaves the daemon as it is when this computer has no key", async () => {
    const keys = createArenaByokKey(createMemoryStorage().storage);
    const daemon = createDaemon({ byok: true, key: "sk-or-other-client" });

    await expect(keys.deliver(daemon.client, "openrouter")).resolves.toEqual({
      available: true,
      configured: true,
      provider: "openrouter",
    });
    expect(daemon.sent).toEqual([]);
  });

  it("sends the newer key when one is saved while the stored key is still being read", async () => {
    const load = deferred<string | null>();
    const storage: ArenaByokKeyStorage = {
      load: () => load.promise,
      save: async () => undefined,
      clear: async () => undefined,
    };
    const keys = createArenaByokKey(storage);
    const daemon = createDaemon({ byok: true });

    const delivery = keys.deliver(daemon.client, "openrouter");
    await keys.set("sk-or-new", "openrouter", []);
    load.resolve("sk-or-old");
    await delivery;

    expect(daemon.sent).toEqual(["sk-or-new"]);
  });
});

describe("checking for a key before a battle starts", () => {
  it("refuses with a message that points to Settings when there is no key", async () => {
    const keys = createArenaByokKey(createMemoryStorage().storage);
    const daemon = createDaemon({ byok: true });

    const start = keys.ensure(daemon.client, "openrouter");

    await expect(start).rejects.toBeInstanceOf(ArenaByokKeyMissingError);
    await expect(start).rejects.toThrow("Add your OpenRouter key in Settings to start a battle.");
  });

  it("hands over the stored key when the daemon has lost it", async () => {
    const keys = createArenaByokKey(createMemoryStorage("sk-or-stored").storage);
    const daemon = createDaemon({ byok: true });

    await keys.ensure(daemon.client, "openrouter");

    expect(daemon.sent).toEqual(["sk-or-stored"]);
  });

  it("keeps a key the daemon already holds, so running battles are not restarted", async () => {
    const keys = createArenaByokKey(createMemoryStorage("sk-or-stored").storage);
    const daemon = createDaemon({ byok: true, key: "sk-or-other-client" });

    await keys.ensure(daemon.client, "openrouter");

    expect(daemon.sent).toEqual([]);
    expect(daemon.held()).toBe("sk-or-other-client");
  });

  it("does not stand in the way of a daemon with a control plane", async () => {
    const keys = createArenaByokKey(createMemoryStorage().storage);
    const daemon = createDaemon({ byok: false });

    await expect(keys.ensure(daemon.client, "openrouter")).resolves.toBeUndefined();
    expect(daemon.sent).toEqual([]);
  });
});

describe("saving and removing the key", () => {
  it("stores the key and hands it to every host that takes one", async () => {
    const memory = createMemoryStorage();
    const keys = createArenaByokKey(memory.storage);
    const local = createDaemon({ byok: true });
    const hosted = createDaemon({ byok: false });

    const statuses = await keys.set("sk-or-new", "openrouter", [
      { serverId: "local", client: local.client },
      { serverId: "hosted", client: hosted.client },
    ]);

    expect(memory.stored()).toBe("sk-or-new");
    expect(local.sent).toEqual(["sk-or-new"]);
    expect(hosted.sent).toEqual([]);
    expect(statuses).toEqual([
      { serverId: "local", status: { available: true, configured: true, provider: "openrouter" } },
      { serverId: "hosted", status: { available: false, configured: false } },
    ]);
  });

  it("removes the stored key and clears it on the daemon", async () => {
    const memory = createMemoryStorage("sk-or-stored");
    const keys = createArenaByokKey(memory.storage);
    const local = createDaemon({ byok: true, key: "sk-or-stored" });

    const statuses = await keys.set(null, "openrouter", [
      { serverId: "local", client: local.client },
    ]);

    expect(memory.stored()).toBeNull();
    expect(local.sent).toEqual([null]);
    expect(statuses).toEqual([
      { serverId: "local", status: { available: true, configured: false, provider: "openrouter" } },
    ]);
    const reconnected = createDaemon({ byok: true });
    await keys.deliver(reconnected.client, "openrouter");
    expect(reconnected.sent).toEqual([]);
  });

  it("hands nothing over and keeps the previous key when it cannot be stored", async () => {
    const storage: ArenaByokKeyStorage = {
      load: async () => "sk-or-stored",
      save: async () => {
        throw new Error("Secure BYOK key storage is unavailable");
      },
      clear: async () => undefined,
    };
    const keys = createArenaByokKey(storage);
    const local = createDaemon({ byok: true });

    await expect(
      keys.set("sk-or-new", "openrouter", [{ serverId: "local", client: local.client }]),
    ).rejects.toThrow("Secure BYOK key storage is unavailable");
    expect(local.sent).toEqual([]);

    await keys.deliver(local.client, "openrouter");
    expect(local.sent).toEqual(["sk-or-stored"]);
  });
});

describe("where the key is stored", () => {
  afterEach(() => {
    asyncStorage.clear();
    vi.unstubAllGlobals();
  });

  it("keeps it in the desktop bridge in Electron and nothing in renderer storage", async () => {
    const encrypted = createMemoryStorage();
    vi.stubGlobal("window", { paseoDesktop: { byok: { key: encrypted.storage } } });

    await platformArenaByokKeyStorage.save("openrouter", "sk-or-desktop");

    expect(encrypted.stored()).toBe("sk-or-desktop");
    expect(asyncStorage.size).toBe(0);
    await expect(platformArenaByokKeyStorage.load("openrouter")).resolves.toBe("sk-or-desktop");
    await platformArenaByokKeyStorage.clear("openrouter");
    expect(encrypted.stored()).toBeNull();
  });

  it("refuses to fall back to renderer storage in Electron without the bridge", async () => {
    vi.stubGlobal("window", { paseoDesktop: {} });

    await expect(platformArenaByokKeyStorage.save("openrouter", "sk-or-desktop")).rejects.toThrow(
      "Encrypted BYOK key storage is unavailable",
    );
    expect(asyncStorage.size).toBe(0);
  });

  it("uses AsyncStorage in the browser QA harness", async () => {
    await platformArenaByokKeyStorage.save("openrouter", "sk-or-browser");

    await expect(platformArenaByokKeyStorage.load("openrouter")).resolves.toBe("sk-or-browser");
    await platformArenaByokKeyStorage.clear("openrouter");
    await expect(platformArenaByokKeyStorage.load("openrouter")).resolves.toBeNull();
  });
});
