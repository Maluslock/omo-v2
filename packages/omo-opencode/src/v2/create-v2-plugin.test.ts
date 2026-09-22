import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createV2Plugin } from "./create-v2-plugin"

type MutableAgent = { id: string; name?: string; permissions: Array<{ action: string; resource: string; effect: string }> }

function createMockEditor() {
  const registry = new Map<string, MutableAgent>()
  return {
    registry,
    list: () => [...registry.values()],
    get: (id: string) => registry.get(id),
    default: (_id: string | undefined) => {},
    update: (id: string, fn: (agent: MutableAgent) => void) => {
      const agent = registry.get(id) ?? {
        id,
        // Emulate the seed `Agent.Info.default(id)` rules the V2 editor prepends.
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      }
      if (!registry.has(id)) registry.set(id, agent)
      fn(agent)
    },
    remove: (id: string) => registry.delete(id),
  }
}

describe("createV2Plugin", () => {
  it("returns a V2 definition with the omo id and a setup function", () => {
    const plugin = createV2Plugin()
    expect(plugin.id).toBe("oh-my-openagent")
    expect(typeof plugin.setup).toBe("function")
  })

  it("setup() resolves on a malformed ctx so the plugin stays loadable", async () => {
    const plugin = createV2Plugin()
    await expect(Promise.resolve(plugin.setup({} as never))).resolves.toBeUndefined()
  })

  it("setup() registers a synchronous agent transform for a real location", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omo-v2-register-"))
    let captured: ((editor: ReturnType<typeof createMockEditor>) => void) | undefined
    const ctx = {
      location: { directory },
      agent: {
        transform: async (callback: (editor: ReturnType<typeof createMockEditor>) => void) => {
          captured = callback
          return { dispose: async () => {} }
        },
      },
    }

    const plugin = createV2Plugin()
    await expect(Promise.resolve(plugin.setup(ctx as never))).resolves.toBeUndefined()

    // The transform is registered and its callback is synchronous (returns undefined, not a Promise).
    expect(typeof captured).toBe("function")
    const editor = createMockEditor()
    const returned = captured?.(editor)
    expect(returned).toBeUndefined()

    // Agents are injected, and for every agent that received incoming rules the
    // editor-seeded default permission is still present (merge, not replace).
    expect(editor.registry.size).toBeGreaterThan(0)
    const agentsWithIncoming = [...editor.registry.values()].filter(
      (agent) => agent.permissions.length > 1,
    )
    expect(agentsWithIncoming.length).toBeGreaterThan(0)
    for (const agent of agentsWithIncoming) {
      expect(agent.permissions.some((p) => p.action === "*" && p.effect === "allow")).toBe(true)
    }
  })
})
