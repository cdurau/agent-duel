import type { ModelPool, ModelProfile } from "./pool"

// The BYOK Ollama Cloud pool. Names are the exact cloud catalog names from `GET /api/tags`;
// no `:cloud` aliases are constructed. All three were verified on 2026-10-30 to offer
// `completion`, `tools` and `vision` (`mistral-large-3:675b` has no `thinking`, the other two do),
// so every one qualifies as a battle contestant under the Arena's image+tools requirement.
export const defaultOllamaPool = [
  {
    displayName: "Mistral Large 4",
    slug: "mistral-large-4",
    canonicalSlug: "mistral-large-4",
    // mistral4.context_length from /api/show on ollama.com.
    contextWindow: 1_048_576,
    routing: {},
    reasoningEffort: null,
  },
  {
    displayName: "GLM 5.3 Flash",
    slug: "glm-5.3-flash",
    canonicalSlug: "glm-5.3-flash",
    // glm5_next.context_length from /api/show on ollama.com.
    contextWindow: 1_048_576,
    routing: {},
    reasoningEffort: null,
  },
  {
    displayName: "Mistral Large 3",
    slug: "mistral-large-3:675b",
    canonicalSlug: "mistral-large-3:675b",
    contextWindow: 1_048_576,
    routing: {},
  },
] as const satisfies ModelPool

// The single-chat "medium" role on Ollama Cloud: a small, fast, cheap model. Verified to support
// `completion` and `tools` (text-only is enough for this role's chat use; vision is required of
// battle contestants, not of the medium chat model).
export const ollamaMediumModel = {
  displayName: "GLM 5.3 Flash",
  slug: "glm-5.3-flash",
  canonicalSlug: "glm-5.3-flash",
  contextWindow: 1_048_576,
  routing: {},
  reasoningEffort: null,
} as const satisfies ModelProfile
