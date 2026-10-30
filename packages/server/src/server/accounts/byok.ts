import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { OpenCodeServerManager } from "../agent/providers/opencode/server-manager.js";
import {
  clearArenaCredentials,
  expectArenaCredentials,
  expectNoArenaCredentials,
  installArenaCredentials,
  readArenaCredentials,
  type ArenaCredentials,
  type ByokProvider,
} from "./credentials.js";

/**
 * How long Arena starts wait for a client that announced a key handover and then neither handed a
 * key over nor said it has none. The app answers within a second of connecting.
 */
const ARENA_BYOK_KEY_HANDOVER_TIMEOUT_MS = 10_000;

/**
 * Holds the user's BYOK provider key for a daemon without a control plane. The renderer stores the
 * key and hands it over after connecting; the daemon keeps it only in memory and passes it to
 * Arena through the child's stdin, never an environment variable or file.
 */
export interface ArenaByokService {
  isConfigured(): boolean;
  /** Which provider the held key pays. */
  provider(): ByokProvider | null;
  /**
   * `client` just connected and hands over its stored key next if it has one. Until it does, or
   * says it has none, Arena starts wait for that key, so the chats the client reopens on
   * connecting do not fail for a key that is on its way.
   */
  expectKey(client: object): void;
  /** `client` has no key to hand over, so Arena starts stop waiting for one from it. */
  expectNoKey(client: object): void;
  /** Installs, replaces, or with `null` clears the key, restarting Arena when it changes. */
  setKey(key: string | null, provider: ByokProvider): Promise<void>;
}

export interface CreateArenaByokServiceOptions {
  readonly restartArena?: () => Promise<void>;
  readonly providerSnapshots?: Pick<ProviderSnapshotManager, "reloadSnapshots">;
  readonly keyHandoverTimeoutMs?: number;
}

function heldCredentials(): Extract<ArenaCredentials, { mode: "byok" }> | null {
  const credentials = readArenaCredentials()?.credentials;
  return credentials?.mode === "byok" ? credentials : null;
}

function heldKey(): string | null {
  const credentials = heldCredentials();
  if (!credentials) return null;
  return credentials.provider === "ollama"
    ? credentials.ollamaApiKey
    : credentials.openRouterApiKey;
}

export function createArenaByokService(
  options: CreateArenaByokServiceOptions = {},
): ArenaByokService {
  const restartArena = options.restartArena ?? (() => OpenCodeServerManager.restartInstance());
  const keyHandoverTimeoutMs = options.keyHandoverTimeoutMs ?? ARENA_BYOK_KEY_HANDOVER_TIMEOUT_MS;
  let transition = Promise.resolve();

  return {
    isConfigured: () => heldKey() !== null,
    provider: () => heldCredentials()?.provider ?? null,
    expectKey(client) {
      if (heldKey() === null) expectArenaCredentials(client, keyHandoverTimeoutMs);
    },
    expectNoKey(client) {
      expectNoArenaCredentials(client);
    },
    setKey(key, provider) {
      async function apply(): Promise<void> {
        // A reconnecting client hands over the key it already gave; that must not interrupt battles.
        const previous = heldCredentials();
        let previousKey: string | null = null;
        if (previous)
          previousKey =
            previous.provider === "ollama" ? previous.ollamaApiKey : previous.openRouterApiKey;
        if (key === previousKey && previous?.provider === provider) return;
        if (key === null) clearArenaCredentials();
        else
          installArenaCredentials({
            mode: "byok",
            provider,
            openRouterApiKey: provider === "openrouter" ? key : "",
            ollamaApiKey: provider === "ollama" ? key : "",
          });
        // Arena cannot start without a key, so the first one has nothing to restart. Restarting
        // anyway would stop the start that a chat reopened on connecting is waiting on.
        if (previous !== null) await restartArena();
        // The app runs before it has a key, so opening a project can cache the opencode provider
        // as failed. Reload it for every project now; the reload starts Arena, so it runs in the
        // background rather than holding up the save. It must not force the load: a forced
        // opencode load replaces the Arena server under every request waiting on its start.
        if (options.providerSnapshots) {
          void options.providerSnapshots.reloadSnapshots({ providers: ["opencode"] });
        }
      }
      const next = transition.then(apply);
      transition = next.catch(() => undefined);
      return next;
    },
  };
}
