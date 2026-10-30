import { createArenaService, type Fetch } from "@agent-duel/arena-service"
import type { ArenaDb } from "@agent-duel/arena-service/collection"
import { isNetworkUnavailable } from "@agent-duel/arena-service/network"
import type { ArenaCredentials } from "./credentials"

/**
 * Where the engine sends assignment, contestant, comparison and metadata requests. Both modes keep
 * the control plane's paths (`/api/arena/assignments`, `/api/arena/comparison`,
 * `/api/arena/metadata`) and the active BYOK provider's inference path (`/api/openrouter/...` or
 * `/api/ollama/...`); `fetch` adds whatever credential the routes need, so callers never branch
 * on the mode.
 */
export interface ArenaBackend {
  readonly url: string
  /** The inference route prefix of the active BYOK provider. */
  readonly inferencePath: string
  readonly fetch: Fetch
}

// BYOK requests never leave the process; the service routes on the path alone.
const inProcessUrl = "http://arena.local"

export function createArenaBackend(credentials: ArenaCredentials, db: () => Promise<ArenaDb>): ArenaBackend {
  if (credentials.mode === "hosted") {
    return {
      url: credentials.controlPlaneUrl,
      inferencePath: "/api/openrouter",
      fetch(input, init) {
        const headers = new Headers(init?.headers)
        headers.set("Authorization", `Bearer ${credentials.token}`)
        return globalThis.fetch(input, { ...init, headers })
      },
    }
  }
  // The user owns the key and the process, so the blinding here is a UI convention and every
  // battle belongs to the one local caller.
  const provider = credentials.provider
  const service = createArenaService({
    resolveCaller: async () => ({ id: "local" }),
    db,
    provider,
    openRouterApiKey: credentials.openRouterApiKey || undefined,
    ollamaApiKey: credentials.ollamaApiKey || undefined,
    networkUnavailable: (error) =>
      isNetworkUnavailable(error, provider === "ollama" ? "ollama.com" : "openrouter.ai"),
    // The per-account limit guards the hosted key; this one is the user's.
    metadataRateLimit: null,
    streamRecovery: false,
  })
  return {
    url: inProcessUrl,
    inferencePath: provider === "ollama" ? "/api/ollama" : "/api/openrouter",
    async fetch(input, init) {
      const response = await service.route(new Request(input, init))
      return response ?? Response.json({ error: "Not found" }, { status: 404 })
    },
  }
}
