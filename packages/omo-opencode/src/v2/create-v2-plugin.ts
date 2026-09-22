import { Plugin } from "@opencode/plugin"

export type V2PluginDefinition = ReturnType<typeof Plugin.define>

/**
 * P0 skeleton: exposes the V2 entrypoint with an empty setup().
 * Business hooks (agents, tools, session hooks, events) land in P1+.
 */
export function createV2Plugin(): V2PluginDefinition {
  return Plugin.define({
    id: "oh-my-openagent",
    async setup() {
      // P0: no hooks registered yet. Loadability is the deliverable.
    },
  })
}
