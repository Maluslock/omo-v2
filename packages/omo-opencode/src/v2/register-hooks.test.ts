// packages/omo-opencode/src/v2/register-hooks.test.ts
import { describe, expect, it } from "bun:test"
import { registerOmoToolHooks } from "./register-hooks"
import type { HookRegistration, V2ToolHookRegistrar } from "./register-hooks"
import type { V1ToolAfterInput, V1ToolAfterOutput, V1ToolBeforeInput, V1ToolBeforeOutput } from "./tool-hook-mapping"

function createRegistrar() {
  const callbacks = new Map<string, (event: unknown) => Promise<void>>()
  const disposed: string[] = []
  const registrar: V2ToolHookRegistrar = async (name, callback) => {
    if (callbacks.has(name)) throw new Error(`duplicate registration: ${name}`)
    callbacks.set(name, callback)
    const registration: HookRegistration = { dispose: async () => { disposed.push(name) } }
    return registration
  }
  return {
    registrar,
    callbacks,
    disposed,
    invoke: (name: string, event: unknown) => {
      const callback = callbacks.get(name)
      if (callback === undefined) throw new Error(`not registered: ${name}`)
      return callback(event)
    },
  }
}

describe("registerOmoToolHooks", () => {
  it("registers only the handlers that were supplied", async () => {
    const { registrar, callbacks } = createRegistrar()
    await registerOmoToolHooks(registrar, {})
    expect(callbacks.size).toBe(0)

    const { registrar: onlyAfter, callbacks: afterOnly } = createRegistrar()
    await registerOmoToolHooks(onlyAfter, { after: () => {} })
    expect([...afterOnly.keys()]).toEqual(["execute.after"])
  })

  it("invokes the V1 before-handler with the V1 pair and writes mutations back", async () => {
    const { registrar, invoke } = createRegistrar()
    const seen: V1ToolBeforeInput[] = []
    await registerOmoToolHooks(registrar, {
      before: (input, output) => {
        seen.push({ ...input })
        input.tool = "omo_glob"
        output.args = { ...output.args, extra: 1 }
      },
    })

    const event: Record<string, unknown> = {
      tool: "mcp_omo_glob",
      sessionID: "ses_1",
      id: "call_1",
      input: { pattern: "*.md" },
    }
    await invoke("execute.before", event)

    expect(seen).toEqual([{ tool: "mcp_omo_glob", sessionID: "ses_1", callID: "call_1" }])
    expect(event.tool).toBe("omo_glob")
    expect(event.input).toEqual({ pattern: "*.md", extra: 1 })
  })

  it("lets a before-handler throw so the tool call is blocked", async () => {
    const { registrar, invoke } = createRegistrar()
    await registerOmoToolHooks(registrar, {
      before: () => {
        throw new Error("blocked")
      },
    })

    await expect(invoke("execute.before", { tool: "bash", sessionID: "ses_1", id: "c", input: {} })).rejects.toThrow("blocked")
  })

  it("invokes the V1 after-handler and writes result mutations back", async () => {
    const { registrar, invoke } = createRegistrar()
    const seen: V1ToolAfterInput[] = []
    await registerOmoToolHooks(registrar, {
      after: (input, output) => {
        seen.push({ ...input })
        output.output = `${output.output}\n\n[truncated]`
        output.title = "Result"
      },
    })

    const event: Record<string, unknown> = {
      tool: "grep",
      sessionID: "ses_1",
      id: "call_1",
      input: { pattern: "x" },
      status: "completed",
      result: { content: "match", metadata: {} },
    }
    await invoke("execute.after", event)

    expect(seen).toEqual([{ tool: "grep", sessionID: "ses_1", callID: "call_1", args: { pattern: "x" } }])
    expect(event.result).toEqual({ content: "match\n\n[truncated]", metadata: { title: "Result" } })
  })

  it("isolates an after-handler failure and leaves the result untouched", async () => {
    const { registrar, invoke } = createRegistrar()
    await registerOmoToolHooks(registrar, {
      after: () => {
        throw new Error("post boom")
      },
    })

    const event: Record<string, unknown> = {
      tool: "grep",
      sessionID: "ses_1",
      id: "call_1",
      status: "completed",
      result: { content: "match", metadata: {} },
    }
    await expect(invoke("execute.after", event)).resolves.toBeUndefined()
    expect(event.result).toEqual({ content: "match", metadata: {} })
  })

  it("skips malformed events without calling the handler", async () => {
    const { registrar, invoke } = createRegistrar()
    let called = 0
    await registerOmoToolHooks(registrar, {
      before: () => { called += 1 },
      after: () => { called += 1 },
    })

    await invoke("execute.before", { tool: "x" })
    await invoke("execute.after", null)
    expect(called).toBe(0)
  })

  it("returns dispose handles for both registrations", async () => {
    const { registrar, disposed } = createRegistrar()
    const registrations = await registerOmoToolHooks(registrar, { before: () => {}, after: () => {} })
    expect(registrations).toHaveLength(2)
    for (const registration of registrations) await registration.dispose()
    expect(disposed).toEqual(["execute.before", "execute.after"])
  })
})
