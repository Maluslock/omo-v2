// packages/omo-opencode/src/tools/delegate-task/delegated-model-config.test.ts
import { describe, expect, it } from "bun:test"
import { applyCategoryParams } from "./delegated-model-config"

const BASE = { providerID: "openai", modelID: "gpt-5.4" }

describe("applyCategoryParams", () => {
  it("applies the documented snake_case category tuning", () => {
    // given a category configured with the keys `CategoryConfigSchema` documents
    const config = { temperature: 0.2, top_p: 0.9, max_tokens: 4321 }

    // when
    const result = applyCategoryParams(BASE, config)

    // then the max output reaches the delegated model (it was silently dropped before)
    expect(result).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
      temperature: 0.2,
      top_p: 0.9,
      maxTokens: 4321,
    })
  })

  it("still honours the deprecated camelCase maxTokens key", () => {
    // given a config that predates the snake_case rename
    const config = { maxTokens: 1234 }

    // when
    const result = applyCategoryParams(BASE, config)

    // then
    expect(result.maxTokens).toBe(1234)
  })

  it("prefers max_tokens over the deprecated maxTokens when both are set", () => {
    // given both spellings, the documented one set last in the schema's deprecation story
    const config = { maxTokens: 1234, max_tokens: 4321 }

    // when
    const result = applyCategoryParams(BASE, config)

    // then the documented key wins, mirroring the reasoning/reasoningEffort precedence
    expect(result.maxTokens).toBe(4321)
  })

  it("leaves max output unset when the category declares neither key", () => {
    // given
    const result = applyCategoryParams(BASE, { temperature: 0.5 })

    // when / then
    expect(result.maxTokens).toBeUndefined()
    expect("maxTokens" in result).toBe(false)
  })

  it("returns the base unchanged when there is no category config", () => {
    // given / when / then
    expect(applyCategoryParams(BASE, undefined)).toEqual(BASE)
  })
})
