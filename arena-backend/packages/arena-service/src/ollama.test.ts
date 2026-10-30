import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { MongoClient } from "mongodb"
import { connectMongoDb, type MongoDb } from "./mongo"
import type { Caller } from "./context"
import { createArenaService, type ArenaService } from "./service"
import { defaultOllamaPool, ollamaMediumModel } from "./ollama-pool"
import { parseOllamaCatalog, validateOllama, type CatalogEntry } from "./ollama"

const uri = process.env.OPENCODE_ARENA_MONGODB_URI
const database = `agent_duel_ollama_test_${crypto.randomUUID().replaceAll("-", "")}`
let client: MongoClient
let db: MongoDb

beforeAll(async () => {
  if (!uri) throw new Error("OPENCODE_ARENA_MONGODB_URI must be set to run the Ollama service tests")
  ;({ client, db } = await connectMongoDb({ uri, database }))
})

beforeEach(async () => {
  await db.collection("arenaAssignmentSets").deleteMany({})
  await db.collection("arenaAssignmentGenerationMetrics").deleteMany({})
})

afterAll(async () => {
  if (!uri) return
  await client.db(database).dropDatabase()
  await client.close()
})

async function callerFromHeader(request: Request): Promise<Caller | undefined> {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "")
  return token ? { id: token } : undefined
}

const catalog = {
  models: [
    { name: "mistral-large-4", capabilities: ["completion", "thinking", "tools", "vision"] },
    { name: "glm-5.3-flash", capabilities: ["completion", "thinking", "tools", "vision"] },
    { name: "mistral-large-3:675b", capabilities: ["completion", "tools", "vision"] },
    { name: "gpt-oss:20b", capabilities: ["completion", "tools", "thinking"] },
  ],
}

function ollamaService(upstream: (body: Record<string, unknown>) => Response, recorded: { url: string; headers: Headers; body: Record<string, unknown> }[]) {
  return createArenaService({
    resolveCaller: callerFromHeader,
    db: async () => db,
    provider: "ollama",
    ollamaApiKey: "ollama-secret",
    openRouterApiKey: undefined,
    validateModels: async () => {},
    fetch: async (input, init) => {
      const text = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as ArrayBuffer)
      const body = JSON.parse(text) as Record<string, unknown>
      recorded.push({ url: String(input), headers: new Headers(init?.headers), body })
      return upstream(body)
    },
    now: () => new Date(),
    uuid: () => crypto.randomUUID(),
    random: () => 0,
  })
}

async function createBattle(service: ArenaService) {
  const response = (await service.route(
    new Request("http://arena.local/api/arena/assignments", {
      method: "POST",
      headers: { Authorization: "Bearer user", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", kind: "battle", scopeID: "battle-1" }),
    }),
  ))!
  expect(response.status).toBe(200)
  const { assignments } = (await response.json()) as { assignments: { assignmentID: string }[] }
  return assignments.map((a) => a.assignmentID)
}

async function postJson(service: ArenaService, url: string, headers: Record<string, string>, body: object) {
  const response = await service.route(
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }),
  )
  if (!response) throw new Error("route answered undefined")
  return response
}

describe("Ollama Cloud BYOK service", () => {
  test("parseOllamaCatalog dedupes and keeps exact names", () => {
    const withDupe = { models: [...catalog.models, { name: "glm-5.3-flash", capabilities: ["vision"] }, { name: " " }] }
    const entries = parseOllamaCatalog(withDupe)
    expect(entries.map((e: CatalogEntry) => e.name)).toEqual([
      "mistral-large-4",
      "glm-5.3-flash",
      "mistral-large-3:675b",
      "gpt-oss:20b",
    ])
    expect(() => parseOllamaCatalog({})).toThrow("invalid model catalog")
    expect(() => parseOllamaCatalog({ models: "x" })).toThrow("invalid model catalog")
  })

  test("validateOllama rejects a pool model without vision or tools", async () => {
    const execute = async () => Response.json(catalog)
    await expect(validateOllama(defaultOllamaPool, "ollama-secret", execute)).resolves.toBeUndefined()
    const textOnly = [{ ...defaultOllamaPool[0], slug: "gpt-oss:20b", canonicalSlug: "gpt-oss:20b", displayName: "gpt-oss:20b" }]
    await expect(validateOllama(textOnly, "ollama-secret", execute)).rejects.toThrow("cannot read images")
    const unknown = [{ ...defaultOllamaPool[0], slug: "not-a-model", canonicalSlug: "not-a-model", displayName: "x" }]
    await expect(validateOllama(unknown, "ollama-secret", execute)).rejects.toThrow("unavailable")
    const failing = async () => Response.json({}, { status: 500 })
    await expect(validateOllama(defaultOllamaPool, "ollama-secret", failing)).rejects.toThrow("status 500")
  })

  test("a contestant chat roundtrip goes to ollama.com with the assigned model and no OpenRouter fields", async () => {
    const recorded: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    const service = ollamaService((body) => {
      if (body.stream === true) {
        const chunks = [
          `data: ${JSON.stringify({ id: "x", choices: [{ delta: { role: "assistant", content: "Hi" } }] })}\n\n`,
          `data: ${JSON.stringify({ id: "x", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`,
          "data: [DONE]\n\n",
        ]
        return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      return Response.json({
        id: "provider-generation",
        model: "hidden-model",
        system_fingerprint: "fp",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.5 },
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      })
    }, recorded)
    const [a, b] = await createBattle(service)
    const response = await postJson(
      service,
      "http://arena.local/api/ollama/api/v1/chat/completions",
      { Authorization: "Bearer user", "x-arena-assignment-id": a ?? "", "x-arena-scope-id": "battle-1" },
      {
        model: "contestant",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "noop", parameters: { type: "object", properties: {} } } }],
        provider: { sort: "throughput" },
        session_id: "leak",
        temperature: 0.5,
      },
    )
    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.model).toBeUndefined()
    expect(payload.system_fingerprint).toBeUndefined()
    expect((payload.usage as Record<string, unknown>).cost).toBeUndefined()
    expect(payload.choices).toBeDefined()
    // Exactly one upstream call, to Ollama Cloud, with the assigned pool model.
    expect(recorded.length).toBe(1)
    const call = recorded[0]!
    expect(call.url).toBe("https://ollama.com/v1/chat/completions")
    expect(call.headers.get("authorization")).toBe("Bearer ollama-secret")
    expect(["mistral-large-4", "glm-5.3-flash", "mistral-large-3:675b"]).toContain(String(call.body.model))
    expect(call.body.provider).toBeUndefined()
    expect(call.body.session_id).toBeUndefined()
    expect(call.body.tool_choice).toBeUndefined()
    expect(call.body.temperature).toBe(0.5)
    expect(call.body.stream_options).toEqual({ include_usage: true })
    // The other assignment is untouched and the route refuses its placeholder on this one.
    const wrong = await postJson(
      service,
      "http://arena.local/api/ollama/api/v1/chat/completions",
      { Authorization: "Bearer user", "x-arena-assignment-id": b ?? "", "x-arena-scope-id": "battle-1" },
      { model: "medium", messages: [] },
    )
    expect(wrong.status).toBe(400)
  })

  test("streaming contestant responses are sanitized SSE", async () => {
    const recorded: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    const service = ollamaService(() => {
      const chunks = [
        `data: ${JSON.stringify({ id: "raw", model: "secret-model", choices: [{ delta: { role: "assistant", reasoning: "private thought", content: "Hel" } }] })}\n\n`,
        `data: ${JSON.stringify({ id: "raw", choices: [{ delta: { content: "lo" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
        "data: [DONE]\n\n",
      ]
      return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
    }, recorded)
    const [a] = await createBattle(service)
    const response = await postJson(
      service,
      "http://arena.local/api/ollama/api/v1/chat/completions",
      { Authorization: "Bearer user", "x-arena-assignment-id": a ?? "", "x-arena-scope-id": "battle-1" },
      { model: "contestant", stream: true, messages: [{ role: "user", content: "hi" }] },
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("data:")
    expect(text).not.toContain("secret-model")
    expect(text).toContain("[DONE]")
    expect(recorded[0]?.url).toBe("https://ollama.com/v1/chat/completions")
  })

  test("upstream 401/404/429 map to neutral contestant errors; query params are refused", async () => {
    const recorded: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    let status = 401
    const service = ollamaService(() => Response.json({ error: { message: "Unauthorized" } }, { status }), recorded)
    const [a] = await createBattle(service)
    const send = (extra = "") =>
      postJson(
        service,
        `http://arena.local/api/ollama/api/v1/chat/completions${extra}`,
        { Authorization: "Bearer user", "x-arena-assignment-id": a ?? "", "x-arena-scope-id": "battle-1" },
        { model: "contestant", messages: [] },
      )
    expect((await send()).status).toBe(401)
    const body = (await (await send()).json()) as { error: { message: string; type: string } }
    expect(body.error.message).toBe("Arena contestant request failed")
    status = 404
    expect((await send()).status).toBe(404)
    status = 429
    expect((await send()).status).toBe(429)
    expect((await send("?x=1")).status).toBe(400)
    // The openrouter route on an Ollama service has no key and answers 503.
    const cross = await postJson(
      service,
      "http://arena.local/api/openrouter/api/v1/chat/completions",
      { Authorization: "Bearer user", "x-arena-assignment-id": a ?? "", "x-arena-scope-id": "battle-1" },
      { model: "contestant", messages: [] },
    )
    expect(cross.status).toBe(503)
  })

  test("medium role uses the Ollama medium model, and comparison goes to ollama.com too", async () => {
    const recorded: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    const service = ollamaService((body) =>
      Response.json({
        choices: [{ message: { role: "assistant", content: body.messages ? "ok" : "" }, finish_reason: "stop" }],
      }),
    recorded)
    // single-agent medium assignment
    const created = await postJson(
      service,
      "http://arena.local/api/arena/assignments",
      { Authorization: "Bearer user" },
      { action: "create", kind: "single", scopeID: "single-1", modelSize: "medium" },
    )
    const { assignments } = (await created.json()) as { assignments: { assignmentID: string }[] }
    const medium = await postJson(
      service,
      "http://arena.local/api/ollama/api/v1/chat/completions",
      { Authorization: "Bearer user", "x-arena-assignment-id": assignments[0]!.assignmentID, "x-arena-scope-id": "single-1" },
      { model: "medium", messages: [{ role: "user", content: "title this" }] },
    )
    expect(medium.status).toBe(200)
    expect(recorded.at(-1)?.body.model).toBe(ollamaMediumModel.slug)
    expect(recorded.at(-1)?.url).toBe("https://ollama.com/v1/chat/completions")
    // comparison route
    const battle = await createBattle(service)
    expect(battle.length).toBe(2)
    const comparison = await postJson(
      service,
      "http://arena.local/api/arena/comparison",
      { Authorization: "Bearer user" },
      { scopeID: "battle-1", messages: [{ role: "user", content: "compare" }], temperature: 0 },
    )
    expect(comparison.status).toBe(200)
    expect(recorded.at(-1)?.url).toBe("https://ollama.com/v1/chat/completions")
    expect(recorded.at(-1)?.headers.get("authorization")).toBe("Bearer ollama-secret")
    expect(recorded.at(-1)?.body).not.toHaveProperty("provider")
  })
})
