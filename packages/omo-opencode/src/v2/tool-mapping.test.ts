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
})
