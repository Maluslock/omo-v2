// packages/omo-opencode/src/v2/tool-mapping.test.ts
import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { normalizeToolResult, toV2Tool } from "./tool-mapping"

describe("normalizeToolResult", () => {
  it("wraps a plain string", () => {
    expect(normalizeToolResult("ok")).toEqual({ content: "ok" })
  })
  it("maps V1 {output,title,metadata} preserving title", () => {
    const out = normalizeToolResult({ output: "body", title: "T", metadata: { a: 1 } })
    expect(out.content).toBe("body")
    expect(out.metadata).toEqual({ title: "T", a: 1 })
  })
  it("maps attachments to file content entries", () => {
    const out = normalizeToolResult({
      output: "done",
      attachments: [{ type: "file", mime: "image/png", url: "file:///x.png", filename: "x.png" }],
    })
    expect(Array.isArray(out.content)).toBe(true)
    expect(out.content).toEqual([
      { type: "text", text: "done" },
      { type: "file", uri: "file:///x.png", mime: "image/png", name: "x.png" },
    ])
  })

  it("gives the explicit V1 title precedence over metadata.title", () => {
    const out = normalizeToolResult({ output: "body", title: "T", metadata: { title: "M" } })
    expect(out.metadata).toEqual({ title: "T" })
  })
})

describe("toV2Tool", () => {
  it("passes zod args through and namespaces the tool", () => {
    const v2 = toV2Tool(
      "glob",
      { description: "d", args: { pattern: z.string() }, execute: async () => "ok" },
      { namespace: "omo", directory: "/tmp" },
    )
    expect(v2.name).toBe("glob")
    expect(v2.description).toBe("d")
    expect(v2.options).toEqual({ namespace: "omo", codemode: false })
    expect(typeof v2.input.parse).toBe("function") // z.object(...) StandardSchema
  })

  it("shims V1 context (directory/sessionID/agent/metadata/abort) and normalizes result", async () => {
    let seenCtx: Record<string, unknown> | undefined
    const v2 = toV2Tool(
      "probe",
      {
        description: "d",
        args: { text: z.string() },
        execute: async (args: { text: string }, ctx: Record<string, unknown>) => {
          seenCtx = ctx
          return `echo:${args.text}`
        },
      },
      { namespace: "omo", directory: "/work" },
    )
    const res = await v2.execute(
      { text: "hi" },
      { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", progress: async () => {} } as never,
    )
    expect(res).toEqual({ content: "echo:hi" })
    expect(seenCtx?.sessionID).toBe("ses_1")
    expect(seenCtx?.agent).toBe("build")
    expect(seenCtx?.directory).toBe("/work")
    expect(typeof seenCtx?.metadata).toBe("function")
    expect(seenCtx?.abort).toBeInstanceOf(AbortSignal)
  })

  it("fails closed when no ask resolver is supplied", async () => {
    const v2 = toV2Tool(
      "gated",
      {
        description: "d",
        args: {},
        execute: async (_args: unknown, ctx: { ask: (i: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void> }) => {
          await ctx.ask({ permission: "shell", patterns: [], always: [], metadata: {} })
          return "approved"
        },
      },
      { namespace: "omo", directory: "/work" },
    )
    await expect(
      v2.execute({}, { sessionID: "s", agent: "a", messageID: "m", id: "c", progress: async () => {} } as never),
    ).rejects.toThrow("ask() is not available in this host; refusing to auto-approve")
  })

  it("supplies a distinct abort signal per execute call", async () => {
    const signals: AbortSignal[] = []
    const v2 = toV2Tool(
      "probe",
      {
        description: "d",
        args: {},
        execute: async (_args: unknown, ctx: { abort: AbortSignal }) => {
          signals.push(ctx.abort)
          return "ok"
        },
      },
      { namespace: "omo", directory: "/work" },
    )
    const ctx = { sessionID: "s", agent: "a", messageID: "m", id: "c", progress: async () => {} } as never
    await v2.execute({}, ctx)
    await v2.execute({}, ctx)
    expect(signals).toHaveLength(2)
    expect(signals[0]).not.toBe(signals[1])
  })

  it("forwards ask to opts.ask when supplied", async () => {
    const seen: Array<{ permission: string }> = []
    const v2 = toV2Tool(
      "gated",
      {
        description: "d",
        args: {},
        execute: async (_args: unknown, ctx: { ask: (i: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void> }) => {
          await ctx.ask({ permission: "shell", patterns: ["*"], always: [], metadata: {} })
          return "done"
        },
      },
      { namespace: "omo", directory: "/work", ask: async (i) => { seen.push(i) } },
    )
    const res = await v2.execute({}, { sessionID: "s", agent: "a", messageID: "m", id: "c", progress: async () => {} } as never)
    expect(res).toEqual({ content: "done" })
    expect(seen).toEqual([{ permission: "shell", patterns: ["*"], always: [], metadata: {} }])
  })
})
