import type { ArenaDb } from "./collection"
import type { ArenaContext, ByokProvider, Caller, Fetch } from "./context"
import { validateOpenRouter, type ModelPool } from "./pool"
import { handleAssignmentsRequest } from "./assignments"
import { handleComparisonRequest } from "./comparison"
import { defaultMetadataRateLimit, handleMetadataRequest, type MetadataRateLimit } from "./metadata"
import { handleOllamaRequest, validateOllama } from "./ollama"
import { handleOpenRouterRequest } from "./openrouter"
import { defaultPool, mediumModel } from "./default-pool"
import { defaultOllamaPool, ollamaMediumModel } from "./ollama-pool"

export type ArenaServiceOptions = {
  /**
   * Who is calling. Return undefined to answer 401. Throw a Response to answer
   * with it, which is how a deployment refuses a known caller (403, 429). Any
   * other throw answers 503, so an outage never reads as a rejected session.
   */
  readonly resolveCaller: (request: Request) => Promise<Caller | undefined>
  readonly db: () => Promise<ArenaDb>
  /**
   * Which BYOK provider pays. Exactly one of the keys below must be set; the pool and catalog
   * validation follow the provider. The hosted control plane always passes `openrouter`.
   */
  readonly provider?: ByokProvider
  readonly pool?: ModelPool
  /** Pays for contestant, comparison, metadata and catalog calls. Without it the routes answer 503. */
  readonly openRouterApiKey: string | undefined
  /** The Ollama Cloud key; used when `provider` is `ollama`. */
  readonly ollamaApiKey?: string | undefined
  readonly fetch?: Fetch
  readonly random?: () => number
  readonly uuid?: () => string
  readonly now?: () => Date
  /** Defaults to checking the pool against the active provider's catalog once per service. */
  readonly validateModels?: (apiKey: string) => Promise<void>
  /**
   * Set where the service runs on the user's machine: whether a failed upstream fetch means the
   * machine is offline, which answers 503 `arena_network_unavailable` so the contestant waits for
   * the network. The control plane leaves it unset; its own outbound failures are not the user's.
   */
  readonly networkUnavailable?: (error: unknown) => Promise<boolean>
  /**
   * Commit message and pull request requests each account may make per window. Defaults to
   * `defaultMetadataRateLimit`; null turns the limit off, as a BYOK engine does for its own key.
   */
  readonly metadataRateLimit?: MetadataRateLimit | null
  /**
   * Heartbeats on contestant streams and a replay route for a response whose connection died
   * (`stream-recovery.ts`). On by default for the control plane; a service on the user's machine has
   * no network between it and the engine and turns it off.
   */
  readonly streamRecovery?: boolean
}

export type ArenaService = {
  readonly assignments: (request: Request) => Promise<Response>
  readonly openrouter: (request: Request) => Promise<Response>
  /** The active provider's inference route; `/api/ollama/...` on an Ollama build. */
  readonly inference: (request: Request) => Promise<Response>
  readonly comparison: (request: Request) => Promise<Response>
  readonly metadata: (request: Request) => Promise<Response>
  /** Answers any of the routes above by path, or undefined when the path is not one of them. */
  readonly route: (request: Request) => Promise<Response | undefined>
}

export function createArenaService(options: ArenaServiceOptions): ArenaService {
  const fetch = options.fetch ?? globalThis.fetch
  const provider: ByokProvider = options.provider ?? "openrouter"
  const pool = options.pool ?? (provider === "ollama" ? defaultOllamaPool : defaultPool)
  const medium = provider === "ollama" ? ollamaMediumModel : mediumModel
  let validation: Promise<void> | undefined
  const context: ArenaContext = {
    resolveCaller: options.resolveCaller,
    db: options.db,
    pool,
    provider,
    openRouterApiKey: options.openRouterApiKey?.trim() || undefined,
    ollamaApiKey: options.ollamaApiKey?.trim() || undefined,
    fetch,
    random: options.random ?? Math.random,
    uuid: options.uuid ?? (() => crypto.randomUUID()),
    now: options.now ?? (() => new Date()),
    validateModels:
      options.validateModels ??
      ((apiKey) =>
        (validation ??= (provider === "ollama"
          ? validateOllama([...pool, medium], apiKey, fetch)
          : validateOpenRouter([...pool, medium], apiKey, fetch)
        ).catch((error) => {
          validation = undefined
          throw error
        }))),
    networkUnavailable: options.networkUnavailable,
    metadataRateLimit:
      options.metadataRateLimit === null ? undefined : (options.metadataRateLimit ?? defaultMetadataRateLimit),
    streamRecovery: options.streamRecovery ?? true,
  }
  const assignments = (request: Request) => handleAssignmentsRequest(request, context)
  const openrouter = (request: Request) => handleOpenRouterRequest(request, context)
  const ollama = (request: Request) => handleOllamaRequest(request, context)
  const inference = provider === "ollama" ? ollama : openrouter
  const comparison = (request: Request) => handleComparisonRequest(request, context)
  const metadata = (request: Request) => handleMetadataRequest(request, context)
  return {
    assignments,
    openrouter,
    inference,
    comparison,
    metadata,
    async route(request) {
      const path = new URL(request.url).pathname
      if (path === "/api/arena/assignments") return assignments(request)
      if (path === "/api/arena/comparison") return comparison(request)
      if (path === "/api/arena/metadata") return metadata(request)
      if (path.startsWith("/api/openrouter/")) return openrouter(request)
      if (path.startsWith("/api/ollama/")) return ollama(request)
      return undefined
    },
  }
}
