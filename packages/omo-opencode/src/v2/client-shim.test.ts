// packages/omo-opencode/src/v2/client-shim.test.ts
import { beforeEach, describe, expect, it } from "bun:test"
import { createV1ClientShim, resetClientShimWarningsForTesting } from "./client-shim"
import type { V1ShimClient, V2ClientShimSource } from "./client-shim"
import { observeSessionActivity, resetSessionActivityForTesting } from "./session-activity"

type Calls = {
  get: Array<Record<string, unknown>>
  create: Array<Record<string, unknown>>
  context: Array<Record<string, unknown>>
  prompt: Array<Record<string, unknown>>
  interrupt: Array<Record<string, unknown>>
  switchAgent: Array<Record<string, unknown>>
  switchModel: Array<Record<string, unknown>>
}

function createSource(overrides: Partial<V2ClientShimSource["session"]> = {}, extra: Partial<V2ClientShimSource> = {}) {
  const calls: Calls = { get: [], create: [], context: [], prompt: [], interrupt: [], switchAgent: [], switchModel: [] }
  const source: V2ClientShimSource = {
    location: { directory: "/work" },
    session: {
      get: async (input) => {
        calls.get.push(input)
        return {
          id: input.sessionID,
          parentID: "ses_parent",
          title: "child",
          location: { directory: "/work/sub" },
          time: { created: 1_700_000_000_000 },
        }
      },
      context: async (input) => {
        calls.context.push(input)
        return [
          { type: "user", id: "m1", text: "hello", time: { created: 1000 } },
          {
            type: "assistant",
            id: "m2",
            finish: "stop",
            time: { created: 2000, completed: 2500 },
            content: [
              { type: "reasoning", text: "thinking" },
              { type: "text", text: "answer" },
              { type: "tool", name: "grep", state: { status: "completed", content: [{ type: "text", text: "match" }] } },
              { type: "tool", name: "bash", state: { status: "running" } },
              { type: "tool", name: "read", state: { status: "error", error: { message: "boom" } } },
            ],
          },
          { type: "system", id: "m3", text: "sys" },
          { type: "synthetic", id: "m4", text: "internal" },
        ]
      },
      create: async (input) => {
        calls.create.push(input)
        return { id: "ses_new", title: input.title, location: { directory: (input.location as { directory?: string })?.directory } }
      },
      prompt: async (input) => {
        calls.prompt.push(input)
        return { id: "inbox_1" }
      },
      interrupt: async (input) => {
        calls.interrupt.push(input)
        return { interrupted: true }
      },
      switchAgent: async (input) => {
        calls.switchAgent.push(input)
      },
      switchModel: async (input) => {
        calls.switchModel.push(input)
      },
      ...overrides,
    },
    agent: {
      list: async () => ({
        location: { directory: "/work" },
        data: [
          { id: "multimodal-looker", name: "multimodal-looker", model: { id: "sonnet", providerID: "anthropic", variant: "high" } },
          { id: "oracle", name: "oracle" },
        ],
      }),
    },
    model: {
      list: async () => ({
        location: { directory: "/work" },
        data: [{ id: "sonnet", modelID: "sonnet-4", providerID: "anthropic" }],
      }),
    },
    ...extra,
  }
  return { source, calls }
}

beforeEach(() => {
  resetClientShimWarningsForTesting()
})

describe("createV1ClientShim session domain", () => {
  it("maps session.get to a V1 {data} response with a legacy directory field", async () => {
    const { source, calls } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    const result = await client.session.get({ path: { id: "ses_1" } })

    expect(calls.get).toEqual([{ sessionID: "ses_1" }])
    expect(result.data?.id).toBe("ses_1")
    expect(result.data?.parentID).toBe("ses_parent")
    expect(result.data?.directory).toBe("/work/sub")
    expect(result.error).toBeUndefined()
  })

  it("converts a session.get rejection into a V1 {error} response", async () => {
    const { source } = createSource({
      get: async () => {
        throw new Error("not found")
      },
    })
    const client: V1ShimClient = createV1ClientShim(source)
    const result = await client.session.get({ path: { id: "ses_1" } })

    expect(result.data).toBeUndefined()
    expect(result.error).toBeInstanceOf(Error)
  })

  it("maps session.create body/query and never forwards parentID", async () => {
    const { source, calls } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    const result = await client.session.create({
      body: {
        parentID: "ses_parent",
        title: "child",
        model: { id: "sonnet", providerID: "anthropic" },
      },
      query: { directory: "/work/sub" },
    })

    expect(calls.create).toEqual([
      {
        title: "child",
        model: { id: "sonnet", providerID: "anthropic" },
        location: { directory: "/work/sub" },
      },
    ])
    expect(result.data?.directory).toBe("/work/sub")
  })

  it("falls back to the plugin location when session.create has no query directory", async () => {
    const { source, calls } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    await client.session.create({ body: { title: "t" } })
    expect(calls.create[0]).toEqual({ title: "t", location: { directory: "/work" } })
  })

  it("maps V2 session messages to V1 {info, parts} and preserves tool state", async () => {
    const { source } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    const result = await client.session.messages({ path: { id: "ses_1" } })
    const data = result.data ?? []

    expect(result.error).toBeUndefined()
    expect(data).toHaveLength(4)

    expect(data[0]?.info).toMatchObject({ role: "user", time: { created: 1000 } })
    expect(data[0]?.parts).toEqual([{ type: "text", text: "hello" }])

    expect(data[1]?.info).toMatchObject({ role: "assistant", finish: "stop", time: { created: 2000, completed: 2500 } })
    expect(data[1]?.parts).toEqual([
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "answer" },
      { type: "tool_result", name: "grep", content: "match", state: "completed" },
      { type: "tool", name: "bash", state: { status: "running" } },
      { type: "tool_result", name: "read", content: "boom", state: "error" },
    ])

    expect(data[2]?.info).toMatchObject({ role: "system" })
    expect(data[3]?.info).toMatchObject({ role: "user" })
  })

  it("applies a trailing limit to session.messages", async () => {
    const { source } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    const result = await client.session.messages({ path: { id: "ses_1" }, query: { directory: "/work", limit: 2 } })
    const data = result.data ?? []
    expect(data).toHaveLength(2)
    expect(data[0]?.info).toMatchObject({ role: "system" })
    expect(data[1]?.info).toMatchObject({ role: "user" })
  })

  it("returns one message by id for session.message, which the V1 recovery and header hooks call", async () => {
    // given a session whose messages are reachable through session.context
    const { source } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)

    // when
    const found = await client.session.message({ path: { id: "ses_1", messageID: "m2" } })

    // then the matching message comes back in the V1 {info, parts} shape
    expect(found.error).toBeUndefined()
    expect(found.data?.info).toMatchObject({ id: "m2", role: "assistant" })
  })

  it("reports an error for a missing message or an incomplete path", async () => {
    const { source } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    expect((await client.session.message({ path: { id: "ses_1", messageID: "nope" } })).data).toBeUndefined()
    expect((await client.session.message({ path: { id: "ses_1", messageID: "nope" } })).error).toBeDefined()
    expect((await client.session.message({ path: { id: "ses_1" } })).error).toBeDefined()
    expect((await client.session.message({})).error).toBeDefined()
  })

  it("reports busy sessions tracked from the host events and keeps an empty todo stub", async () => {
    // given a shim built over a host that publishes no status domain
    const { source } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    resetSessionActivityForTesting()

    // when nothing has been observed / a turn is in flight / the turn ended
    const idle = await client.session.status()
    observeSessionActivity("session.execution.started", "ses_live")
    const busy = await client.session.status()
    observeSessionActivity("session.execution.succeeded", "ses_live")
    const ended = await client.session.status()

    // then the map tracks the live turn instead of always being empty, and todo stays a stub
    expect(idle).toEqual({ data: {} })
    expect(busy).toEqual({ data: { ses_live: { type: "busy" } } })
    expect(ended).toEqual({ data: {} })
    expect(await client.session.todo({ path: { id: "ses_1" } })).toEqual({ data: [] })
  })

  it("maps a real captured V2 context payload (session import round-trip)", async () => {
    // Captured from `GET /api/session/:sessionID/context` on opencode v2.0.11 after importing a
    // session with one user and one assistant+tool message. See
    // `.omo/evidence/20260923-v2-client-shim/http-session-context-imported.json`.
    const captured = [
      { id: "msg_import_u", time: { created: 1000 }, text: "hi from import", type: "user" },
      {
        id: "msg_import_a",
        time: { created: 2000, completed: 2500 },
        type: "assistant",
        agent: "sisyphus",
        model: { id: "sonnet", providerID: "anthropic" },
        content: [
          { type: "reasoning", text: "thinking", time: { created: 2050, completed: 2060 } },
          { type: "text", text: "hello" },
          {
            type: "tool",
            id: "call_1",
            name: "grep",
            state: {
              status: "completed",
              input: { pattern: "x" },
              content: [{ type: "text", text: "match-line" }],
              metadata: {},
            },
            time: { created: 2100, completed: 2200 },
          },
        ],
        finish: "stop",
      },
    ]
    const { source } = createSource({ context: async () => captured })
    const client: V1ShimClient = createV1ClientShim(source)
    const data = (await client.session.messages({ path: { id: "ses_1" } })).data ?? []

    expect(data[0]?.info).toMatchObject({ role: "user", time: { created: 1000 } })
    expect(data[0]?.parts).toEqual([{ type: "text", text: "hi from import" }])
    expect(data[1]?.info).toMatchObject({
      role: "assistant",
      finish: "stop",
      time: { created: 2000, completed: 2500 },
    })
    expect(data[1]?.parts).toEqual([
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "hello" },
      { type: "tool_result", name: "grep", content: "match-line", state: "completed" },
    ])
  })

  it("maps session.abort onto session.interrupt", async () => {
    const { source, calls } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    const result = await client.session.abort({ path: { id: "ses_1" } })

    expect(calls.interrupt).toEqual([{ sessionID: "ses_1" }])
    expect(result.data).toBe(true)
  })

  it("converts an interrupt rejection into {data:false, error}", async () => {
    const { source } = createSource({
      interrupt: async () => {
        throw new Error("nope")
      },
    })
    const client: V1ShimClient = createV1ClientShim(source)
    const result = await client.session.abort({ path: { id: "ses_1" } })
    expect(result.data).toBe(false)
    expect(result.error).toBeInstanceOf(Error)
  })
})

describe("createV1ClientShim prompt dispatch", () => {
  it("maps promptAsync to a queued V2 prompt with joined text parts", async () => {
    const { source, calls } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    const result = await client.session.promptAsync?.({
      path: { id: "ses_1" },
      body: { parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    })

    expect(calls.prompt).toEqual([{ sessionID: "ses_1", text: "a\n\nb", delivery: "queue" }])
    expect(result).toEqual({ id: "inbox_1" })
  })

  it("maps the synchronous prompt to a steering V2 prompt", async () => {
    const { source, calls } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    await client.session.prompt?.({ path: { id: "ses_1" }, body: { parts: [{ type: "text", text: "sync" }] } })
    expect(calls.prompt[0]?.["delivery"]).toBe("steer")
  })

  it("applies agent and model before prompting and maps modelID to id", async () => {
    const { source, calls } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    await client.session.promptAsync?.({
      path: { id: "ses_1" },
      body: {
        agent: "oracle",
        model: { providerID: "anthropic", modelID: "sonnet" },
        variant: "high",
        parts: [{ type: "text", text: "go" }],
      },
    })

    expect(calls.switchAgent).toEqual([{ sessionID: "ses_1", agent: "oracle" }])
    expect(calls.switchModel).toEqual([{ sessionID: "ses_1", model: { providerID: "anthropic", id: "sonnet", variant: "high" } }])
    expect(calls.prompt[0]).toEqual({ sessionID: "ses_1", text: "go", delivery: "queue" })
  })

  it("maps V1 file parts to V2 attachments (uri and inline data URLs)", async () => {
    const { source, calls } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    await client.session.promptAsync?.({
      path: { id: "ses_1" },
      body: {
        parts: [
          { type: "text", text: "look" },
          { type: "file", mime: "image/png", url: "file:///tmp/a.png", filename: "a.png" },
          { type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64,QUJD", filename: "b.jpg" },
        ],
      },
    })

    expect(calls.prompt[0]?.["files"]).toEqual([
      { data: "", mime: "image/png", source: { type: "uri", uri: "file:///tmp/a.png" }, name: "a.png" },
      { data: "QUJD", mime: "image/jpeg", source: { type: "inline" }, name: "b.jpg" },
    ])
  })

  it("omits prompt and promptAsync entirely when the host has no V2 prompt method", () => {
    const { source } = createSource({ prompt: undefined })
    const client: V1ShimClient = createV1ClientShim(source)
    expect(client.session.promptAsync).toBeUndefined()
    expect(client.session.prompt).toBeUndefined()
  })
})

describe("createV1ClientShim adapter surfaces", () => {
  it("maps app.agents to the V1 agent shape with a providerID/modelID model ref", async () => {
    const { source } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    const result = await client.app.agents()
    expect(result.data?.[0]).toEqual({
      id: "multimodal-looker",
      name: "multimodal-looker",
      model: { providerID: "anthropic", modelID: "sonnet", variant: "high" },
      variant: "high",
    })
    expect(result.data?.[1]?.model).toBeUndefined()
  })

  it("maps model.list rows to {provider, id} for delegate-task availability", async () => {
    const { source } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    const result = await client.model.list()
    expect(result.data?.[0]).toMatchObject({ provider: "anthropic", id: "sonnet" })
  })

  it("returns an empty config.get stub so host-skill resolution falls back", async () => {
    const { source } = createSource()
    const client: V1ShimClient = createV1ClientShim(source)
    expect(await client.config.get()).toEqual({ data: {} })
  })

  it("exposes a tui.showToast no-op so V1 toast call sites cannot crash the hook chain", async () => {
    // given a shim with no V2 TUI domain
    const { source } = createSource()
    const client = createV1ClientShim(source)

    // when / then the call resolves instead of throwing on an undefined property read
    expect(await client.tui.showToast({ body: { title: "Provider Cache Missing" } })).toEqual({ data: true })
    expect(await client.tui.showToast({})).toEqual({ data: true })
  })

  it("degrades agent/model list failures to empty data", async () => {
    const { source } = createSource({}, {
      agent: { list: async () => { throw new Error("boom") } },
      model: { list: async () => { throw new Error("boom") } },
    })
    const client: V1ShimClient = createV1ClientShim(source)
    expect((await client.app.agents()).data).toEqual([])
    expect((await client.model.list()).data).toEqual([])
  })
})
