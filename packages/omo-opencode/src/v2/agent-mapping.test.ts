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
})
