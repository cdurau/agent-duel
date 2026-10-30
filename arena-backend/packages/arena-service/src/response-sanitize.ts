import type { StoredGenerationMetrics, UsageTotals } from "./metrics"
import { retryableStreamError } from "./request-error"
import { HEARTBEAT_LINE, HEARTBEAT_MS } from "./stream-recovery"
import type { ReplayRecorder } from "./stream-recovery"

/** The sanitizer/readback pair a contestant stream's reasoning goes through. */
export type ReasoningRedactor = ReturnType<typeof import("./reasoning").createReasoningRedactor>

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeUsage(value: unknown) {
  if (!record(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.toLowerCase().includes("cost")))
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function nonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function usage(value: unknown, latencyMs: number): UsageTotals | undefined {
  if (!record(value)) return undefined
  const source = record(value.usage)
    ? value.usage
    : record(value.data) && record(value.data.usage)
      ? value.data.usage
      : undefined
  if (!source) return undefined
  const promptDetails = record(source.prompt_tokens_details) ? source.prompt_tokens_details : undefined
  const completionDetails = record(source.completion_tokens_details) ? source.completion_tokens_details : undefined
  const cacheDetails = record(source.cache_tokens) ? source.cache_tokens : undefined
  const promptTokens = number(source.prompt_tokens ?? source.input_tokens)
  const completionTokens = number(source.completion_tokens ?? source.output_tokens)
  const costDetails = record(source.cost_details) ? source.cost_details : undefined
  const upstreamInferenceCost = nonNegativeNumber(costDetails?.upstream_inference_cost)
  return {
    promptTokens,
    completionTokens,
    reasoningTokens: number(completionDetails?.reasoning_tokens ?? source.reasoning_tokens),
    totalTokens: number(source.total_tokens) || promptTokens + completionTokens,
    cacheReadTokens: number(promptDetails?.cached_tokens ?? cacheDetails?.read ?? source.cache_read_tokens),
    cacheWriteTokens: number(promptDetails?.cache_write_tokens ?? cacheDetails?.write ?? source.cache_write_tokens),
    cost: number(source.cost ?? value.cost),
    ...(upstreamInferenceCost === undefined ? {} : { upstreamInferenceCost }),
    attempts: 1,
    latencyMs,
  }
}

function finishReason(value: unknown) {
  if (!record(value)) return undefined
  if (typeof value.status === "string" && ["completed", "incomplete", "failed"].includes(value.status)) {
    return value.status
  }
  if (!Array.isArray(value.choices)) return undefined
  for (const choice of value.choices) {
    if (!record(choice)) continue
    const reason = choice.finish_reason ?? choice.finishReason
    if (typeof reason === "string" && reason.trim()) return reason
  }
  return undefined
}

// A `/responses` stream nests the response, with its usage, status and provider, in each event.
function generation(value: unknown) {
  return record(value) && record(value.response) ? value.response : value
}

export function metricsCollector(generationID: string, startedAt: number) {
  let usagePayload: unknown
  let finished: string | undefined
  let provider: string | undefined
  return {
    observe(event: unknown) {
      const value = generation(event)
      if (record(value) && (value.usage !== undefined || (record(value.data) && value.data.usage !== undefined))) {
        usagePayload = value
      }
      finished = finishReason(value) ?? finished
      if (record(value) && typeof value.provider === "string" && value.provider) provider = value.provider
    },
    value(): StoredGenerationMetrics | undefined {
      const measured = usage(usagePayload, Math.max(0, Date.now() - startedAt))
      if (!measured && !finished) return undefined
      return {
        generationID,
        ...(measured ? { usage: measured } : {}),
        ...(finished ? { finishReason: finished } : {}),
        ...(provider ? { provider } : {}),
      }
    },
  }
}

export function sanitizePayload(value: unknown, generationID: string, stream = false): unknown {
  if (!record(value)) return value
  if (value.error !== undefined) {
    return {
      error: {
        message: "Arena contestant request failed",
        type: stream && retryableStreamError(value.error) ? "arena_retryable_stream_error" : "arena_upstream_error",
      },
    }
  }
  const sanitized = { ...value }
  if ("id" in sanitized) sanitized.id = generationID
  for (const key of [
    "model",
    "model_id",
    "provider",
    "provider_name",
    "openrouter_metadata",
    "system_fingerprint",
    "cost",
    "cost_details",
  ]) {
    delete sanitized[key]
  }
  if ("usage" in sanitized) sanitized.usage = sanitizeUsage(sanitized.usage)
  if (record(sanitized.data)) sanitized.data = sanitizePayload(sanitized.data, generationID)
  if (record(sanitized.response)) sanitized.response = sanitizePayload(sanitized.response, generationID)
  return sanitized
}

function sanitizeLine(
  line: string,
  generationID: string,
  reasoning: ReasoningRedactor,
  observe?: (value: unknown) => void,
) {
  if (!line.startsWith("data:")) return ""
  const raw = line.slice("data:".length).trimStart()
  if (!raw) return line
  try {
    if (raw === "[DONE]") {
      const tail = reasoning.flush()
      reasoning.clear()
      return tail ? `data: ${JSON.stringify({ id: generationID, ...tail })}\n\n${line}` : line
    }
    const value = JSON.parse(raw) as unknown
    observe?.(value)
    return `data: ${JSON.stringify(reasoning.redact(sanitizePayload(value, generationID, true), true))}`
  } catch {
    reasoning.clear()
    return `data: ${JSON.stringify({
      error: { message: "Arena contestant stream failed", type: "arena_stream_error" },
    })}`
  }
}

export function sanitizeStream(
  stream: ReadableStream<Uint8Array>,
  generationID: string,
  reasoning: ReasoningRedactor,
  startedAt: number,
  complete: (metrics: StoredGenerationMetrics | undefined) => Promise<void>,
  recovery?: ReplayRecorder,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  let cancelled = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let lastWrite = Date.now()
  const metrics = metricsCollector(generationID, startedAt)
  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = undefined
  }
  // Whether the client has data lines of an event whose closing blank line it has not received. An
  // error written into that event becomes one more data line, the client cannot parse the joined
  // data, and a retryable failure turns into a final one.
  let open = false
  const write = (controller: ReadableStreamDefaultController<Uint8Array>, text: string) => {
    controller.enqueue(encoder.encode(text))
    recovery?.record(text)
    lastWrite = Date.now()
  }
  const writeLine = (controller: ReadableStreamDefaultController<Uint8Array>, line: string) => {
    if (open && line.startsWith('data: {"error":')) write(controller, "\n")
    write(controller, `${line}\n`)
    if (line.startsWith("data:")) open = true
    else if (line === "") open = false
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (!recovery) return
      // A model that thinks without output still sends comments, so a quiet connection is a dead one.
      heartbeat = setInterval(() => {
        if (Date.now() - lastWrite < HEARTBEAT_MS) return
        try {
          controller.enqueue(encoder.encode(`${HEARTBEAT_LINE}\n`))
          lastWrite = Date.now()
        } catch {
          stopHeartbeat()
        }
      }, HEARTBEAT_MS / 4)
    },
    async pull(controller) {
      try {
        // A pull that emits nothing may never be called again. Keep reading a fragmented SSE line.
        while (true) {
          const next = await reader.read()
          if (cancelled) return
          if (next.done) {
            pending += decoder.decode()
            if (pending) writeLine(controller, sanitizeLine(pending, generationID, reasoning, metrics.observe))
            if (open) writeLine(controller, "")
            const tail = reasoning.flush()
            if (tail) write(controller, `\n\ndata: ${JSON.stringify({ id: generationID, ...tail })}\n\n`)
            reasoning.clear()
            stopHeartbeat()
            // Recorded before the close: a hosted function may stop once its response ends.
            await Promise.all([complete(metrics.value()), recovery?.complete()])
            controller.close()
            return
          }
          pending += decoder.decode(next.value, { stream: true })
          const lines = pending.split("\n")
          pending = lines.pop() ?? ""
          if (!lines.length) continue
          for (const line of lines) writeLine(controller, sanitizeLine(line, generationID, reasoning, metrics.observe))
          return
        }
      } catch {
        reasoning.clear()
        stopHeartbeat()
        if (cancelled) return
        await recovery?.fail()
        controller.enqueue(
          encoder.encode(
            `${open ? "\n" : ""}data: ${JSON.stringify({
              error: { message: "Arena contestant request failed", type: "arena_retryable_stream_error" },
            })}\n\n`,
          ),
        )
        controller.close()
      }
    },
    cancel(reason) {
      cancelled = true
      stopHeartbeat()
      reasoning.clear()
      void recovery?.fail()
      return reader.cancel(reason)
    },
  })
}

export function assignedHeaders(source: Headers) {
  const headers = new Headers()
  for (const name of ["content-type", "cache-control", "retry-after"]) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}
