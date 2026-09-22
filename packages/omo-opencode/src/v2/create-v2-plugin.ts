import { Plugin } from "@opencode/plugin"
import { loadPluginConfig } from "../plugin-config"
import { log } from "../shared"
import { registerOmoAgents } from "./register-agents"
import { registerOmoTools } from "./register-tools"

export type V2PluginDefinition = ReturnType<typeof Plugin.define>

/**
 * V2 entrypoint.
 *
 * `setup(ctx)` assembles omo's agents and tools, injecting them through
 * `ctx.agent.transform` and `ctx.tool.transform` respectively.
 * Registration is best-effort: a config-load or assembly failure is logged and
 * swallowed so the host can always load the plugin (P0 loadability contract).
 */
export function createV2Plugin(): V2PluginDefinition {
  return Plugin.define({
    id: "oh-my-openagent",
    async setup(ctx) {
      try {
        const pluginConfig = loadPluginConfig(ctx.location.directory, ctx)
        await registerOmoAgents(ctx, pluginConfig)
        await registerOmoTools(ctx, pluginConfig)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log("[v2] registration skipped", { error: message })
      }
    },
  })
}
