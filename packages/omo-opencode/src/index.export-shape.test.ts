import { describe, expect, it } from "bun:test"
import pluginModule, { omoPlugin } from "./index"

describe("oh-my-openagent plugin export shape", () => {
  it("keeps the V1 server export aligned with the default module", () => {
    // given
    const defaultServer = pluginModule.server

    // when
    const namedServer = omoPlugin

    // then
    expect(typeof defaultServer).toBe("function")
    expect(namedServer).toBe(defaultServer)
  })

  it("exposes a V2 definition (id + setup) on the default export", () => {
    expect(pluginModule.id).toBe("oh-my-openagent")
    expect(typeof pluginModule.setup).toBe("function")
  })
})
