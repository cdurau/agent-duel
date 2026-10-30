import type { ArenaContext, ByokProvider } from "./context"
import { OLLAMA_API_ORIGIN, OLLAMA_CHAT_COMPLETIONS_PATH } from "./ollama"

const OPENROUTER_CHAT_COMPLETIONS = "https://openrouter.ai/api/v1/chat/completions"

// The comparison and the metadata text run on a cheap, fast model, tried in this order. Each entry
// pins one provider, because the reasoning setting is tuned per provider: Baseten ignores
// `effort: low` and reasons for thousands of tokens, so DeepSeek runs with reasoning off.
/** @deprecated The OpenRouter utility models; kept for the existing tests. */
export const utilityModels = [
  {
    id: "qwen/qwen3.8-27b",
    provider: "cerebras",
    reasoning: { effort: "low" },
    routing: { order: ["cerebras"], allow_fallbacks: false, require_parameters: true },
  },
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    provider: "baseten",
    reasoning: { enabled: false },
    routing: { order: ["baseten"], allow_fallbacks: false, require_parameters: true },
  },
] as const

const openRouterUtilityModels = utilityModels

// On Ollama Cloud there is no provider sort and no `provider` routing field, so the utility role
// uses one small fast cloud model (verified 2026-10-30: completion + tools + vision) without a
// reasoning override — `reasoning_effort` names are model-defined and an unsupported value would
// not be an error, so none is sent.
const ollamaUtilityModels = [{ id: "glm-5.3-flash" }] as const

function utilityTarget(provider: ByokProvider, apiKey: string) {
  if (provider === "ollama") {
    return { url: `${OLLAMA_API_ORIGIN}${OLLAMA_CHAT_COMPLETIONS_PATH}`, key: apiKey }
  }
  return { url: OPENROUTER_CHAT_COMPLETIONS, key: apiKey }
}

/**
 * Sends one chat completion to the first utility model that accepts it. Any failure status or
 * network error moves on to the next model; the last model's answer is returned as it is. A
 * response that has started streaming is never retried.
 */
export async function requestUtilityModel(
  context: Pick<ArenaContext, "fetch" | "provider" | "openRouterApiKey" | "ollamaApiKey">,
  input: {
    readonly headers: Record<string, string>
    readonly body: Record<string, unknown>
    readonly signal: AbortSignal
  },
) {
  const apiKey = context.provider === "ollama" ? context.ollamaApiKey : context.openRouterApiKey
  if (!apiKey) throw new Error("No utility model credential is configured")
  const target = utilityTarget(context.provider, apiKey)
  const models = context.provider === "ollama" ? ollamaUtilityModels : openRouterUtilityModels
  for (const [index, model] of models.entries()) {
    const last = index === models.length - 1
    try {
      const extra =
        context.provider === "ollama"
          ? {}
          : { reasoning: (model as (typeof openRouterUtilityModels)[number]).reasoning, provider: (model as (typeof openRouterUtilityModels)[number]).routing }
      const response = await context.fetch(target.url, {
        method: "POST",
        headers: { ...input.headers, Authorization: `Bearer ${target.key}` },
        body: JSON.stringify({
          model: model.id,
          ...input.body,
          ...extra,
        }),
        signal: input.signal,
      })
      if (response.ok || last) return response
      await response.body?.cancel().catch(() => undefined)
      console.error(`[arena-service] Utility model ${model.id} failed with status ${response.status}`)
    } catch (error) {
      if (last || input.signal.aborted) throw error
      console.error(`[arena-service] Utility model ${model.id} failed`)
    }
  }
  throw new Error("No utility model is configured")
}
