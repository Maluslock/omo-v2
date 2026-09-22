import { describe, expect, it } from "bun:test"
import { createV2Plugin } from "./create-v2-plugin"

describe("createV2Plugin", () => {
  it("returns a V2 definition with the omo id and a setup function", () => {
    const plugin = createV2Plugin()
    expect(plugin.id).toBe("oh-my-openagent")
    expect(typeof plugin.setup).toBe("function")
  })
})
