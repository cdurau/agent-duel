import { randomUUID } from "crypto"
import {
  recordAssignmentGenerationMetrics,
  reserveRoutingAssignment,
  type SingleAgentModelSize,
} from "./assignments"
import { authorize, type ArenaContext } from "./context"
import {
  classifyPaymentError,
  compactionRequiredError,
  isContextOverflow,
  networkUnavailableError,
} from "./request-error"
import { modelLimits, type ModelPool, type ModelProfile } from "./pool"
import { prepareRequest } from "./request-budget"
import { createReasoningRedactor } from "./reasoning"
import { assignedHeaders, record, sanitizePayload, sanitizeStream } from "./response-sanitize"
import type { StoredGenerationMetrics } from "./metrics"
import { REPLAY_PATH, replayRecorder, replayResponse } from "./stream-recovery"

/**
 * Ollama Cloud's OpenAI-compatible endpoint (`https://ollama.com/v1`). Only chat completions is
 * used: the Arena's tool cycle, streaming, vision and usage reporting all work there, and
 * Ollama's `/responses` API is stateless, so it cannot carry a contestant conversation.
 */
export const OLLAMA_API_ORIGIN = "https://ollama.com"
/** The upstream path for one chat completion. */
export const OLLAMA_CHAT_COMPLETIONS_PATH = "/v1/chat/completions"
/** The engine-visible route suffix, with the `/api/ollama` prefix stripped. */
const CHAT_COMPLETIONS_SUFFIX = "/api/v1/chat/completions"

type OllamaShowResponse = {
  capabilities?: unknown
  model_info?: unknown
  thinking?: unknown
}

export type CatalogEntry = {
  readonly name: string
  readonly capabilities: ReadonlySet<string>
  readonly contextLength?: number
  readonly thinkingValues?: readonly string[]
}

function strings(value: unknown) {
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
}

function contextLengthOf(modelInfo: unknown, modelName: string): number | undefined {
  if (!record(modelInfo)) return undefined
  const architecture = record(modelInfo["general.architecture"])
    ? String(modelInfo["general.architecture"])
    : undefined
  const key = architecture ? `${architecture}.context_length` : undefined
  const value = key ? modelInfo[key] : undefined
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Reads one cloud model's capabilities and context window from `/api/show`, which works directly
 * against `ollama.com` with the API key. Returns undefined when the endpoint does not answer with
 * usable data, so the caller keeps the entry unverified instead of guessing.
 */
export async function fetchOllamaModelInfo(
  name: string,
  apiKey: string,
  execute: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<CatalogEntry | undefined> {
  let response: Response
  try {
    response = await execute(`${OLLAMA_API_ORIGIN}/api/show`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  let parsed: OllamaShowResponse
  try {
    parsed = (await response.json()) as OllamaShowResponse
  } catch {
    return undefined
  }
  const thinking = record(parsed.thinking) && Array.isArray(parsed.thinking.values)
    ? parsed.thinking.values.filter((item): item is string => typeof item === "string")
    : undefined
  return {
    name,
    capabilities: strings(parsed.capabilities),
    ...(contextLengthOf(parsed.model_info, name) === undefined
      ? {}
      : { contextLength: contextLengthOf(parsed.model_info, name) }),
    ...(thinking === undefined || thinking.length === 0 ? {} : { thinkingValues: thinking }),
  }
}

type OllamaTagsModel = {
  readonly name?: unknown
  readonly capabilities?: unknown
}

/** Parses `GET /api/tags`; throws on anything that is not a catalog object. */
export function parseOllamaCatalog(value: unknown): CatalogEntry[] {
  if (!record(value) || !Array.isArray(value.models)) {
    throw new Error("Ollama returned an invalid model catalog")
  }
  const entries: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const item of value.models) {
    if (!record(item) || typeof item.name !== "string" || !item.name.trim()) continue
    const name = item.name.trim()
    if (seen.has(name)) continue
    seen.add(name)
    entries.push({ name, capabilities: strings(item.capabilities) })
  }
  return entries
}

/** A catalog entry the Arena can use: its name survives unchanged, no `:cloud` alias is built. */
export function toOllamaProfile(entry: CatalogEntry, fallbackContextWindow: number): ModelProfile {
  const profile: ModelProfile = {
    displayName: entry.name,
    slug: entry.name,
    canonicalSlug: entry.name,
    contextWindow: entry.contextLength ?? fallbackContextWindow,
    routing: {},
  }
  return entry.capabilities.has("thinking") ? { ...profile, reasoningEffort: null } : profile
}

/** Validates an Ollama pool against the live cloud catalog; throws with the first reason. */
export async function validateOllama(
  pool: ModelPool,
  apiKey: string,
  execute: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
) {
  const response = await execute(`${OLLAMA_API_ORIGIN}/api/tags`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) throw new Error(`Ollama model catalog request failed with status ${response.status}`)
  const catalog = parseOllamaCatalog(await response.json())
  const byName = new Map(catalog.map((entry) => [entry.name, entry]))
  for (const profile of pool) {
    const entry = byName.get(profile.slug)
    if (!entry) throw new Error(`Arena contestant is unavailable on Ollama Cloud: ${profile.displayName}`)
    if (!entry.capabilities.has("tools") || !entry.capabilities.has("completion")) {
      throw new Error(`Arena contestant is missing required text or tool capabilities: ${profile.displayName}`)
    }
    // Every contestant is offered the same image attachments; one that cannot read them would
    // lose the battle to its input and refusing the send only for that draw would reveal the model.
    if (!entry.capabilities.has("vision")) {
      throw new Error(`Arena contestant cannot read images: ${profile.displayName}`)
    }
  }
}

function assignmentHeaders(request: Request) {
  const assignmentHeader = request.headers.get("x-arena-assignment-id")
  const scopeHeader = request.headers.get("x-arena-scope-id")
  const assignmentID = assignmentHeader?.trim()
  const scopeID = scopeHeader?.trim()
  const hasAssignmentHeader = assignmentHeader !== null
  const hasScopeHeader = scopeHeader !== null
  if (!assignmentID || !scopeID || !hasAssignmentHeader || !hasScopeHeader) return undefined
  return { assignmentID, scopeID }
}

// Ollama Cloud needs no per-session routing keys: it has no provider sort and its prompt cache is
// automatic, so the body is forwarded as the engine sent it, minus the fields it does not support.
const unsupportedFields = new Set(["provider", "model_id", "models", "preset", "presets", "route", "tool_choice", "session_id", "prompt_cache_key", "cache_control"])

function translatedBody(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !unsupportedFields.has(key.toLowerCase())))
}

const MAX_LOGGED_REFUSAL = 4_000

function logRefusal(context: object, status: number, upstream: string) {
  console.error(
    "[arena-service] Ollama Cloud refused a contestant request",
    JSON.stringify({ ...context, status, upstream: upstream.slice(0, MAX_LOGGED_REFUSAL) }),
  )
}

/**
 * The Ollama Cloud counterpart of `handleOpenRouterRequest`: same routes, same assignment scope,
 * same sanitized neutral transport, but the upstream is `https://ollama.com/v1/chat/completions`
 * and the model is the assignment's own slug instead of the `contestant`/`medium` placeholders.
 */
export async function handleOllamaRequest(request: Request, context: ArenaContext) {
  const caller = await authorize(request, context, (message, status) =>
    Response.json({ error: { message } }, { status }),
  )
  if (caller instanceof Response) return caller
  const apiKey = context.ollamaApiKey
  if (!apiKey) return Response.json({ error: { message: "Ollama Cloud is unavailable" } }, { status: 503 })

  const url = new URL(request.url)
  const suffix = url.pathname.replace(/^\/api\/ollama/, "")
  if (request.method !== "POST" || (suffix !== CHAT_COMPLETIONS_SUFFIX && suffix !== REPLAY_PATH)) {
    return Response.json({ error: { message: "Arena assignment cannot access this route" } }, { status: 400 })
  }
  if (url.search) {
    return Response.json({ error: { message: "Arena Ollama query parameters are not supported" } }, { status: 400 })
  }
  const requestedGenerationID = request.headers.get("x-arena-generation-id")?.trim()
  if (requestedGenerationID && !/^gen_[0-9a-f]{32}$/i.test(requestedGenerationID)) {
    return Response.json({ error: { message: "Arena generation ID is invalid" } }, { status: 400 })
  }
  if (suffix === REPLAY_PATH && !requestedGenerationID) {
    return Response.json({ error: { message: "Arena generation ID is required" } }, { status: 400 })
  }
  if (suffix === REPLAY_PATH && !context.streamRecovery) {
    return Response.json({ error: { message: "Arena assignment cannot access this route" } }, { status: 400 })
  }
  const body = await request.arrayBuffer().catch(() => undefined)
  if (!body) return Response.json({ error: { message: "Arena Ollama request body is required" } }, { status: 400 })
  let input: unknown
  try {
    input = JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch {
    return Response.json({ error: { message: "Arena Ollama request body is invalid JSON" } }, { status: 400 })
  }
  if (!record(input)) {
    return Response.json({ error: { message: "Arena Ollama request body must be an object" } }, { status: 400 })
  }
  if (input.model !== "contestant" && input.model !== "medium") {
    return Response.json({ error: { message: "Arena contestant model is invalid" } }, { status: 400 })
  }
  const assignment = assignmentHeaders(request)
  if (!assignment) {
    return Response.json({ error: { message: "Arena assignment scope is invalid" } }, { status: 400 })
  }

  const db = await context.db()
  const routeAssignment = await reserveRoutingAssignment(db, caller.id, assignment.scopeID, assignment.assignmentID)
  if (!routeAssignment) return Response.json({ error: { message: "Arena assignment is invalid" } }, { status: 403 })
  const expectedModel = routeAssignment.modelSize === "medium" ? "medium" : "contestant"
  if (input.model !== expectedModel) {
    return Response.json({ error: { message: "Arena contestant model is invalid" } }, { status: 400 })
  }

  try {
    const reasoning = createReasoningRedactor(apiKey, {
      userId: caller.id,
      scopeID: assignment.scopeID,
      assignmentID: assignment.assignmentID,
    })
    const restored = reasoning.restore(input)
    const generationID = requestedGenerationID || `gen_${randomUUID().replaceAll("-", "")}`
    const startedAt = Date.now()
    if (suffix === REPLAY_PATH && requestedGenerationID) {
      return await replayResponse(
        db,
        { userId: caller.id, ...assignment, generationID: requestedGenerationID },
        context.now,
        request.signal,
      )
    }
    const routed = {
      ...translatedBody(restored),
      model: routeAssignment.model.slug,
      stream_options: record(restored.stream_options)
        ? { ...(restored.stream_options as Record<string, unknown>), include_usage: true }
        : { include_usage: true },
    }
    const limits = modelLimits(routeAssignment.model)
    const budget = prepareRequest(routed, "chat", limits)
    const upstream = new URL(`${OLLAMA_API_ORIGIN}${OLLAMA_CHAT_COMPLETIONS_PATH}`)
    const headers = new Headers()
    headers.set("Authorization", `Bearer ${apiKey}`)
    headers.set("Accept", request.headers.get("accept") || "application/json")
    headers.set("Content-Type", "application/json")
    const payload = new TextEncoder().encode(budget.body).buffer
    const response = await context.fetch(upstream, {
      method: "POST",
      headers,
      body: payload,
      signal: request.signal,
    })
    const refusal = {
      userId: caller.id,
      scopeID: assignment.scopeID,
      assignmentID: assignment.assignmentID,
      generationID,
      model: routeAssignment.model.slug,
    }
    if (!response.ok) {
      const upstreamText = await response.text().catch(() => "")
      logRefusal(refusal, response.status, upstreamText)
      const responseHeaders = assignedHeaders(response.headers)
      if (isContextOverflow(response.status, upstreamText)) {
        return Response.json(compactionRequiredError(), { status: 413, headers: responseHeaders })
      }
      if (response.status === 402) {
        let parsed: unknown = null
        try {
          parsed = JSON.parse(upstreamText)
        } catch {
          parsed = null
        }
        return Response.json(classifyPaymentError(parsed), { status: 402, headers: responseHeaders })
      }
      return Response.json(
        { error: { message: "Arena contestant request failed", type: "arena_upstream_error" } },
        { status: response.status, headers: responseHeaders },
      )
    }
    const recordMetrics = async (metrics: StoredGenerationMetrics | undefined) => {
      if (!metrics || !requestedGenerationID) return
      try {
        await recordAssignmentGenerationMetrics(db, {
          userId: caller.id,
          scopeID: assignment.scopeID,
          assignmentID: assignment.assignmentID,
          metrics,
        })
      } catch {
        console.error("[arena-service] Arena generation metrics could not be recorded")
      }
    }
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream") && response.body) {
      const recovery = context.streamRecovery && requestedGenerationID
        ? () => replayRecorder(db, { userId: caller.id, ...assignment, generationID: requestedGenerationID }, context.now)
        : undefined
      const responseHeaders = assignedHeaders(response.headers)
      return new Response(
        sanitizeStream(response.body, generationID, reasoning, startedAt, recordMetrics, recovery?.()),
        { status: response.status, headers: responseHeaders },
      )
    }
    const raw = await response.json()
    await recordMetrics(undefined)
    const responseHeaders = assignedHeaders(response.headers)
    responseHeaders.set("content-type", "application/json")
    return Response.json(reasoning.redact(sanitizePayload(raw, generationID)), {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (error) {
    if (await context.networkUnavailable?.(error)) return Response.json(networkUnavailableError(), { status: 503 })
    console.error("[arena-service] Ollama Cloud proxy failed")
    return Response.json({ error: { message: "Ollama Cloud request failed" } }, { status: 502 })
  }
}
