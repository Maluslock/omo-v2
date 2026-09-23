// packages/omo-opencode/src/v2/model-request-hook-mapping.test.ts
import { describe, expect, it } from "bun:test"
import { applyV1ChatParams, toV1ChatParams } from "./model-request-hook-mapping"

const CONTEXT_EVENT = {
  sessionID: "ses_1",
  agent: "sisyphus",
  model: { id: "sonnet", providerID: "anthropic" },
  system: [],
  messages: [],
  options: { existing: true },
  tools: {},
}

describe("toV1ChatParams", () => {
  it("projects the model/provider ref and the current options", () => {
    expect(toV1ChatParams(CONTEXT_EVENT)).toEqual({
      input: {
        sessionID: "ses_1",
        agent: "sisyphus",
        model: { providerID: "anthropic", modelID: "sonnet" },
        provider: { id: "anthropic" },
      },
      output: { options: { existing: true } },
    })
  })

  it("returns undefined when the model ref is incomplete", () => {
    expect(toV1ChatParams(null)).toBeUndefined()
    expect(toV1ChatParams({ sessionID: "ses_1" })).toBeUndefined()
    expect(toV1ChatParams({ sessionID: "ses_1", model: { providerID: "anthropic" } })).toBeUndefined()
    expect(toV1ChatParams({ sessionID: "ses_1", model: { id: "sonnet" } })).toBeUndefined()
  })

  it("omits a non-string agent and tolerates missing options", () => {
    const pair = toV1ChatParams({ sessionID: "ses_1", agent: 7, model: { id: "m", providerID: "p" } })
    expect(pair?.input.agent).toBeUndefined()
    expect(pair?.output.options).toEqual({})
  })
})

describe("applyV1ChatParams", () => {
  it("lifts V1 scalar settings and options onto the context options", () => {
    const event = structuredClone(CONTEXT_EVENT) as Record<string, unknown>
    const pair = toV1ChatParams(event)!
    pair.output.temperature = 0.2
    pair.output.topP = 0.9
    pair.output.maxOutputTokens = 32000
    pair.output.options = { ...pair.output.options, reasoningEffort: "high" }

    applyV1ChatParams(event, pair.output)

    expect(event.options).toEqual({
      existing: true,
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 32000,
      reasoningEffort: "high",
    })
  })

  it("does not introduce settings the handler never set", () => {
    const event = structuredClone(CONTEXT_EVENT) as Record<string, unknown>
    const pair = toV1ChatParams(event)!
    applyV1ChatParams(event, pair.output)
    expect(event.options).toEqual({ existing: true })
  })

  it("creates options when the event had none and ignores malformed events", () => {
    const event: Record<string, unknown> = { sessionID: "ses_1", model: { id: "m", providerID: "p" } }
    applyV1ChatParams(event, { options: { reasoningEffort: "low" } })
    expect(event.options).toEqual({ reasoningEffort: "low" })
    expect(() => applyV1ChatParams(null, { options: {} })).not.toThrow()
  })
})
