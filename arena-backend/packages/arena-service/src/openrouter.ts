import { createHash, createHmac, randomUUID } from "crypto"
import { recordAssignmentGenerationMetrics, reserveRoutingAssignment, type SingleAgentModelSize } from "./assignments"
import { authorize, type ArenaContext, type Fetch } from "./context"
import { KEEP_ALIVE_HEADER, keepAliveAnswer, keepsCacheWarm } from "./keep-alive"
import type { StoredGenerationMetrics } from "./metrics"
import {
  classifyPaymentError,
  compactionRequiredError,
  isContextOverflow,
  networkUnavailableError,
} from "./request-error"
import { modelLimits, type ModelLimits, type ModelPool, type ModelProfile } from "./pool"
import { COMPACTION_HEADER, COMPACTION_OFFER, prepareRequest } from "./request-budget"
import {
  calibrate,
  MAX_CALIBRATION_RATIO,
  needsCalibration,
  readCalibration,
  recordCalibration,
  type CalibrationSample,
} from "./request-calibration"
import { createReasoningRedactor } from "./reasoning"
import { assignedHeaders, metricsCollector, record, sanitizePayload, sanitizeStream } from "./response-sanitize"
import {
  HEARTBEAT_HEADER,
  HEARTBEAT_MS,
  REPLAY_PATH,
  replayRecorder,
  replayResponse,
  type ReplayRecorder,
} from "./stream-recovery"

type ReasoningRedactor = ReturnType<typeof createReasoningRedactor>

// Anthropic caches a prompt only when the request asks, and the blinded engine cannot tell it is
// talking to Claude, so without this every contestant step pays full input price for the whole
// conversation. OpenRouter puts the breakpoint on the last cacheable block of each request. The
// engine sends no tools only for compaction summaries and titles, whose prefix no later request
// shares, so a write there would cost 25% more and never be read. A body that marks its own
// breakpoints keeps them alone: one more could exceed Anthropic's four or clash with their TTL, and
// only Claude requests would fail.
function promptCache(slug: string, input: Record<string, unknown>) {
  const tools = Array.isArray(input.tools) ? input.tools : []
  if (!slug.startsWith("anthropic/") || tools.length === 0 || input.cache_control !== undefined) return {}
  const messages = Array.isArray(input.messages) ? input.messages : []
  const marked = messages.some(
    (message) =>
      record(message) &&
      (message.cache_control !== undefined ||
        (Array.isArray(message.content) &&
          message.content.some((part) => record(part) && part.cache_control !== undefined))),
  )
  return marked ? {} : { cache_control: { type: "ephemeral" } }
}

// The engine cannot tell which model it is talking to, so any sampling it sends was chosen for no
// model in particular (the title agent asks for a temperature of 0.5). Claude and OpenAI's reasoning
// models take none of these, and under the pool's `require_parameters` OpenRouter then finds no
// endpoint, so only those draws would fail. Every contestant runs on its provider's defaults.
const samplingParameters = new Set(["temperature", "top_p", "top_k"])

function withoutSampling(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !samplingParameters.has(key)))
}

const alternateSelectors = new Set(["model_id", "models", "preset", "presets", "provider", "provider_name", "route"])

const unsupportedServerFeatures = new Set(["plugin", "plugins", "server_tools", "web_search_options"])

function invalidRequestBody(input: unknown) {
  if (!record(input)) return "Arena OpenRouter request body must be an object"
  for (const key of Object.keys(input)) {
    const normalized = key.toLowerCase()
    if (alternateSelectors.has(normalized)) return `Arena OpenRouter request field is not allowed: ${key}`
    if (unsupportedServerFeatures.has(normalized)) return `Arena OpenRouter request field is not supported: ${key}`
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) return "Arena OpenRouter tools must be an array"
    for (const tool of input.tools) {
      if (!record(tool) || tool.type !== "function") return "Arena OpenRouter server-side tools are not supported"
    }
  }
  return undefined
}

// A battle side lives for one turn, so its assignment id keys its cache and its provider. A
// single-agent chat draws a new assignment for every message over one growing conversation, and a
// key per message would send each message's first call away from the cache the last one wrote. The
// engine names that scope after the session and the message (`ensureSingleAgentRating` in
// `opencode/src/arena/service.ts`), so the key is a keyed hash of the account and the session: the
// same for the whole chat, whatever model each message draws, and naming neither.
const singleAgentScope = /^single-agent\|(\d+):/

function cacheKey(
  apiKey: string,
  userId: string,
  scopeID: string,
  assignment: { readonly assignmentID: string; readonly modelSize?: SingleAgentModelSize },
) {
  const match = assignment.modelSize === undefined ? null : singleAgentScope.exec(scopeID)
  if (!match) return assignment.assignmentID
  const sessionID = scopeID.slice(match[0].length, match[0].length + Number(match[1]))
  if (!sessionID || sessionID.length !== Number(match[1])) return assignment.assignmentID
  const key = createHash("sha256").update("arena-cache-key-v1\0").update(apiKey).digest()
  return createHmac("sha256", key).update(`${userId.length}:${userId}|${sessionID}`).digest("hex").slice(0, 32)
}

/** The fields the proxy decides for every contestant call, replacing any the engine sent. */
function assignedRouting(model: ModelProfile, modelSize: SingleAgentModelSize | undefined, key: string) {
  return {
    model: model.slug,
    reasoning:
      model.reasoningEffort === null
        ? { enabled: true }
        : { effort: model.reasoningEffort ?? (modelSize === "medium" ? "xhigh" : "high") },
    provider: model.routing,
    // Without these OpenRouter's throughput sort can move a conversation to another provider whose
    // cache is empty, and some providers miss their own cache without a key.
    session_id: key,
    prompt_cache_key: key,
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

// Enough of an upstream error to name the cause; some provider errors quote the request.
const MAX_LOGGED_REFUSAL = 4_000

interface RefusalContext {
  readonly userId: string
  readonly scopeID: string
  readonly assignmentID: string
  readonly generationID: string
  readonly model: string
}

// The client only ever gets a neutral answer, so the reason OpenRouter gave is logged here, the one
// place that sees it. `scopeID` is the battle ID a feedback report carries, which finds the line.
function logRefusal(context: RefusalContext, status: number, upstream: string) {
  console.error(
    "[arena-service] OpenRouter refused a contestant request",
    JSON.stringify({ ...context, status, upstream: upstream.slice(0, MAX_LOGGED_REFUSAL) }),
  )
}

// Nobody reads a ping's one token. Whether it read the cache is what tells a ping that kept the
// entry from one that landed on another provider and wrote a new one, so that much is logged.
/**
 * A ping that failed kept nothing warm, so it gets one more try. Every ping still gets the same
 * answer, so a failure names no model.
 */
async function keepCacheWarm(send: () => Promise<Response>, startedAt: number, signal: AbortSignal) {
  for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
    if (await logKeepAlive(await send().catch(() => undefined), startedAt)) break
  }
  return keepAliveAnswer()
}

async function logKeepAlive(response: Response | undefined, startedAt: number) {
  const text = await response?.text().catch(() => undefined)
  if (!response?.ok || text === undefined) {
    console.warn("[arena-service] Keep-alive ping failed", JSON.stringify({ status: response?.status ?? "unsent" }))
    return false
  }
  const metrics = metricsCollector("keep-alive", startedAt)
  const values = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").flatMap((line) => {
        const raw = line.startsWith("data:") ? line.slice("data:".length).trim() : ""
        return raw && raw !== "[DONE]" ? [raw] : []
      })
    : [text]
  for (const raw of values) {
    try {
      metrics.observe(JSON.parse(raw))
    } catch {
      // A line that is not JSON carries no usage.
    }
  }
  const measured = metrics.value()
  console.info(
    "[arena-service] Keep-alive ping",
    JSON.stringify({
      provider: measured?.provider,
      promptTokens: measured?.usage?.promptTokens,
      cacheReadTokens: measured?.usage?.cacheReadTokens,
      cacheWriteTokens: measured?.usage?.cacheWriteTokens,
    }),
  )
  return true
}

/**
 * The engine sends `auto` for a step it could summarize first, and nothing for a request it cannot
 * shrink: a chat's first message, the step right after a summary, or the summary request itself,
 * which the engine splits into smaller batches when it does not fit. Only `auto` compacts at the
 * model's level; every request still compacts when it cannot fit the endpoint at all. An engine that sends no header
 * therefore keeps its own threshold. The answer names no limit: the levels identify the model.
 */
async function compactionRequired(
  request: Request,
  budget: { readonly input: number; readonly output: number },
  limits: ModelLimits,
  sample: () => Promise<CalibrationSample | undefined>,
) {
  const fits = limits.context - budget.output
  // modelLimits keeps compactAt within context − output, so it always fits.
  const level = request.headers.get(COMPACTION_HEADER) === COMPACTION_OFFER ? limits.compactAt : fits
  // Most requests are far below their level whatever the tokenizer; skip the read for those.
  if (budget.input * MAX_CALIBRATION_RATIO < level) return false
  const measured = calibrate(budget.input, await sample().catch(() => undefined))
  return measured >= level
}

async function sanitizeAssignedResponse(
  response: Response,
  refusal: RefusalContext,
  reasoning: ReasoningRedactor,
  startedAt: number,
  complete: (metrics: StoredGenerationMetrics | undefined) => Promise<void>,
  recovery?: () => ReplayRecorder | undefined,
) {
  const { generationID } = refusal
  const headers = assignedHeaders(response.headers)
  if (!response.ok) {
    const upstream = await response.text().catch(() => "")
    logRefusal(refusal, response.status, upstream)
    if (isContextOverflow(response.status, upstream)) {
      return Response.json(compactionRequiredError(), { status: 413, headers })
    }
    if (response.status === 402) {
      let payload: unknown = null
      try {
        payload = JSON.parse(upstream)
      } catch {
        payload = null
      }
      return Response.json(classifyPaymentError(payload), { status: 402, headers })
    }
    return Response.json(
      { error: { message: "Arena contestant request failed", type: "arena_upstream_error" } },
      { status: response.status, headers },
    )
  }
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream") && response.body) {
    const recorder = recovery?.()
    if (recorder) headers.set(HEARTBEAT_HEADER, String(HEARTBEAT_MS))
    return new Response(sanitizeStream(response.body, generationID, reasoning, startedAt, complete, recorder), {
      status: response.status,
      headers,
    })
  }
  const raw = await response.json()
  const metrics = metricsCollector(generationID, startedAt)
  metrics.observe(raw)
  await complete(metrics.value())
  const payload = reasoning.redact(sanitizePayload(raw, generationID))
  headers.set("content-type", "application/json")
  return Response.json(payload, { status: response.status, headers })
}

export async function handleOpenRouterRequest(request: Request, context: ArenaContext) {
  const caller = await authorize(request, context, (message, status) =>
    Response.json({ error: { message } }, { status }),
  )
  if (caller instanceof Response) return caller
  const apiKey = context.openRouterApiKey
  if (!apiKey) return Response.json({ error: { message: "OpenRouter is unavailable" } }, { status: 503 })

  const url = new URL(request.url)
  const suffix = url.pathname.replace(/^\/api\/openrouter/, "")
  if (!suffix.startsWith("/api/v1/")) return Response.json({ error: { message: "Not found" } }, { status: 404 })
  const upstream = new URL(`https://openrouter.ai${suffix}`)
  const headers = new Headers()
  headers.set("Authorization", `Bearer ${apiKey}`)
  headers.set("Accept", request.headers.get("accept") || "application/json")
  const contentType = request.headers.get("content-type")
  if (contentType) headers.set("Content-Type", contentType)
  headers.set("X-OpenRouter-Metadata", "enabled")

  try {
    let body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    const assignment = assignmentHeaders(request)
    if (!assignment) {
      return Response.json({ error: { message: "Arena assignment scope is invalid" } }, { status: 400 })
    }
    if (url.search) {
      return Response.json(
        { error: { message: "Arena OpenRouter query parameters are not supported" } },
        { status: 400 },
      )
    }
    const requestedGenerationID = request.headers.get("x-arena-generation-id")?.trim()
    if (requestedGenerationID && !/^gen_[0-9a-f]{32}$/i.test(requestedGenerationID)) {
      return Response.json({ error: { message: "Arena generation ID is invalid" } }, { status: 400 })
    }
    if (context.streamRecovery && request.method === "POST" && suffix === REPLAY_PATH) {
      if (!requestedGenerationID) {
        return Response.json({ error: { message: "Arena generation ID is required" } }, { status: 400 })
      }
      const db = await context.db()
      const routeAssignment = await reserveRoutingAssignment(db, caller.id, assignment.scopeID, assignment.assignmentID)
      if (!routeAssignment) return Response.json({ error: { message: "Arena assignment is invalid" } }, { status: 403 })
      return await replayResponse(
        db,
        { userId: caller.id, ...assignment, generationID: requestedGenerationID },
        context.now,
        request.signal,
      )
    }
    if (request.method !== "POST" || !["/api/v1/chat/completions", "/api/v1/responses"].includes(suffix)) {
      return Response.json({ error: { message: "Arena assignment cannot access this route" } }, { status: 400 })
    }

    if (!body)
      return Response.json({ error: { message: "Arena OpenRouter request body is required" } }, { status: 400 })
    let input: unknown
    try {
      input = JSON.parse(new TextDecoder().decode(body)) as unknown
    } catch {
      return Response.json({ error: { message: "Arena OpenRouter request body is invalid JSON" } }, { status: 400 })
    }
    const bodyError = invalidRequestBody(input)
    if (bodyError) return Response.json({ error: { message: bodyError } }, { status: 400 })
    if (!record(input)) {
      return Response.json({ error: { message: "Arena OpenRouter request body must be an object" } }, { status: 400 })
    }
    if (input.model !== "contestant" && input.model !== "medium") {
      return Response.json({ error: { message: "Arena contestant model is invalid" } }, { status: 400 })
    }
    const db = await context.db()
    const routeAssignment = await reserveRoutingAssignment(db, caller.id, assignment.scopeID, assignment.assignmentID)
    if (!routeAssignment) return Response.json({ error: { message: "Arena assignment is invalid" } }, { status: 403 })
    const calibrationKey = { userId: caller.id, scopeID: assignment.scopeID, assignmentID: assignment.assignmentID }
    const expectedModel = routeAssignment.modelSize === "medium" ? "medium" : "contestant"
    if (input.model !== expectedModel) {
      return Response.json({ error: { message: "Arena contestant model is invalid" } }, { status: 400 })
    }
    const keepAlive = request.headers.get(KEEP_ALIVE_HEADER) === "1"
    if (keepAlive && (suffix !== "/api/v1/chat/completions" || !keepsCacheWarm(routeAssignment.model.slug))) {
      return keepAliveAnswer()
    }
    const reasoning = createReasoningRedactor(apiKey, {
      userId: caller.id,
      scopeID: assignment.scopeID,
      assignmentID: assignment.assignmentID,
    })
    const restored = reasoning.restore(input)
    const generationID = requestedGenerationID || `gen_${randomUUID().replaceAll("-", "")}`
    const startedAt = Date.now()
    const endpoint = suffix === "/api/v1/responses" ? "responses" : "chat"
    const routed = {
      ...withoutSampling(restored),
      ...assignedRouting(
        routeAssignment.model,
        routeAssignment.modelSize,
        cacheKey(apiKey, caller.id, assignment.scopeID, routeAssignment),
      ),
      ...promptCache(routeAssignment.model.slug, input),
      stream_options: record(input.stream_options)
        ? { ...input.stream_options, include_usage: true }
        : { include_usage: true },
    }
    if (keepAlive) {
      // A ping repeats a request the proxy already accepted. The output cap is not part of the
      // cached prompt, so the ping reads what the call wrote.
      body = new TextEncoder().encode(
        JSON.stringify({ ...routed, max_tokens: 1, max_completion_tokens: undefined }),
      ).buffer
      return await keepCacheWarm(
        () => context.fetch(upstream, { method: request.method, headers, body, signal: request.signal }),
        startedAt,
        request.signal,
      )
    }
    const limits = modelLimits(routeAssignment.model)
    const budget = prepareRequest(routed, endpoint, limits)
    if (await compactionRequired(request, budget, limits, () => readCalibration(db, calibrationKey))) {
      return Response.json(compactionRequiredError(), { status: 413 })
    }
    body = new TextEncoder().encode(budget.body).buffer
    const response = await context.fetch(upstream, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
    })
    // Awaited so a body that fails to read or parse still gets the 502 below.
    const refusal = {
      userId: caller.id,
      scopeID: assignment.scopeID,
      assignmentID: assignment.assignmentID,
      generationID,
      model: routeAssignment.model.slug,
    }
    const recordGeneration = async (metrics: StoredGenerationMetrics | undefined) => {
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
    const recordMeasuredInput = async (metrics: StoredGenerationMetrics | undefined) => {
      const promptTokens = metrics?.usage?.promptTokens
      if (!promptTokens || !needsCalibration(budget.input, limits.compactAt)) return
      await recordCalibration(db, calibrationKey, { estimate: budget.input, promptTokens }).catch(() => {
        console.error("[arena-service] Arena request calibration could not be recorded")
      })
    }
    // Both writes finish before the stream closes, so they run side by side.
    const recordMetrics = async (metrics: StoredGenerationMetrics | undefined) => {
      await Promise.all([recordGeneration(metrics), recordMeasuredInput(metrics)])
    }
    const recovery = () =>
      context.streamRecovery && requestedGenerationID
        ? replayRecorder(db, { userId: caller.id, ...assignment, generationID: requestedGenerationID }, context.now)
        : undefined
    return await sanitizeAssignedResponse(response, refusal, reasoning, startedAt, recordMetrics, recovery)
  } catch (error) {
    if (await context.networkUnavailable?.(error)) return Response.json(networkUnavailableError(), { status: 503 })
    console.error("[arena-service] OpenRouter proxy failed")
    return Response.json({ error: { message: "OpenRouter request failed" } }, { status: 502 })
  }
}

/**
 * Sends one small tool-carrying request per profile with the fields `assignedRouting` adds. Under
 * `require_parameters` OpenRouter refuses a field a model's providers lack for that model's draws
 * only, and the refusal tells the voter which model it is. The catalog check cannot show that, so
 * run this before a pool change ships. It pays for one call per profile.
 */
export async function probeRouting(pool: ModelPool, apiKey: string, execute: Fetch = fetch) {
  for (const profile of pool) {
    const response = await execute("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...assignedRouting(profile, undefined, randomUUID()),
        messages: [{ role: "user", content: "Reply with OK." }],
        tools: [{ type: "function", function: { name: "noop", parameters: { type: "object", properties: {} } } }],
        stream: false,
      }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(
        `Arena contestant refused the proxy's routing fields: ${profile.displayName} (${response.status}) ${detail.slice(0, MAX_LOGGED_REFUSAL)}`,
      )
    }
  }
}
