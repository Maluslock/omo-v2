// packages/omo-opencode/src/v2/agent-mapping.test.ts
import { describe, expect, it } from "bun:test"
import { toV2AgentInfo } from "./agent-mapping"

describe("toV2AgentInfo", () => {
  it("maps description/prompt/mode and parses the model ref", () => {
    const out = toV2AgentInfo("oracle", {
      description: "consulting agent",
      mode: "subagent",
      model: "litellm/deepseek-flash#max",
      prompt: "You are Oracle.",
    })
    expect(out.name).toBe("oracle")
    expect(out.description).toBe("consulting agent")
    expect(out.mode).toBe("subagent")
    expect(out.system).toBe("You are Oracle.")
    expect(out.model).toEqual({ providerID: "litellm", id: "deepseek-flash", variant: "max" })
  })

  it("maps V1 tools to permissions (write/edit/patch collapse to edit)", () => {
    const out = toV2AgentInfo("x", { tools: { read: true, bash: false, edit: false } })
    expect(out.permissions).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
    ])
  })

  it("defaults mode to subagent and omits absent fields", () => {
    const out = toV2AgentInfo("y", {})
    expect(out.mode).toBe("subagent")
    expect(out.model).toBeUndefined()
    expect(out.system).toBeUndefined()
    expect(out.permissions).toBeUndefined()
  })

  it("keeps a primary mode and forwards temperature/top_p into request.body", () => {
    const out = toV2AgentInfo("z", { mode: "primary", temperature: 0.2, top_p: 0.9 })
    expect(out.mode).toBe("primary")
    expect(out.request).toEqual({ body: { temperature: 0.2, top_p: 0.9 } })
  })

  it("prefers the V1 permission map and preserves ask", () => {
    const out = toV2AgentInfo("p", { permission: { bash: "deny", read: "allow", edit: "ask" } })
    expect(out.permissions).toEqual([
      { action: "shell", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "ask" },
    ])
  })

  it("maps apply_patch to edit", () => {
    const out = toV2AgentInfo("a", { permission: { apply_patch: "allow" } })
    expect(out.permissions).toEqual([{ action: "edit", resource: "*", effect: "allow" }])
  })

  it("honors an independent V1 variant field", () => {
    const out = toV2AgentInfo("v", { model: "anthropic/claude-x", variant: "max" })
    expect(out.model).toEqual({ providerID: "anthropic", id: "claude-x", variant: "max" })
  })

  it("falls back to the legacy tools map when permission is absent", () => {
    const out = toV2AgentInfo("t", { tools: { bash: false, read: true } })
    expect(out.permissions).toEqual([
      { action: "shell", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
    ])
  })
})
