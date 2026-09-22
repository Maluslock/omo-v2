import { Plugin } from "@opencode/plugin"
import { loadPluginConfig } from "../plugin-config"
import { log } from "../shared"
import { registerOmoAgents } from "./register-agents"

export type V2PluginDefinition = ReturnType<typeof Plugin.define>

/**
 * V2 entrypoint.
 *
 * `setup(ctx)` assembles omo's agents and injects them through `ctx.agent.transform`.
 * Agent registration is best-effort: a config-load or assembly failure is logged and
 * swallowed so the host can always load the plugin (P0 loadability contract).
 */
export function createV2Plugin(): V2PluginDefinition {
  return Plugin.define({
    id: "oh-my-openagent",
    async setup(ctx) {
      try {
        const pluginConfig = loadPluginConfig(ctx.location.directory, ctx)
        await registerOmoAgents(ctx, pluginConfig)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log("[v2] agent registration skipped", { error: message })
      }
    },
  })
}
