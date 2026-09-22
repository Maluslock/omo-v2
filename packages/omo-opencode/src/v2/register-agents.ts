// packages/omo-opencode/src/v2/register-agents.ts
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { applyAgentConfig } from "../plugin-handlers/agent-config-handler"
import {
  loadPluginComponents,
  type PluginComponents,
} from "../plugin-handlers/plugin-components-loader"
import { log } from "../shared"
import { toV2AgentInfo } from "./agent-mapping"

type V2Ctx = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0]

/**
 * Assemble omo's V1-shaped agent config and project it into the V2 agent registry.
 *
 * `applyAgentConfig` only needs `ctx.directory` (verified: no `ctx.client` usage in the
 * handler chain), so we hand it a minimal `{ directory }`. All async work is completed
 * before `ctx.agent.transform` runs because V2 transform callbacks must be synchronous.
 */
export async function registerOmoAgents(
  ctx: V2Ctx,
  pluginConfig: OhMyOpenCodeConfig,
  pluginComponents?: PluginComponents,
): Promise<void> {
  const components = pluginComponents ?? (await loadPluginComponents({ pluginConfig }))

  const config: Record<string, unknown> = {}
  const agentResult = await applyAgentConfig({
    config,
    pluginConfig,
    ctx: { directory: ctx.location.directory },
    pluginComponents: components,
  })

  const defaultAgent =
    typeof config.default_agent === "string" ? config.default_agent : undefined

  // Precompute the full V2 payload before entering the synchronous transform callback.
  const mappedAgents = new Map<string, Record<string, unknown>>()
  for (const [id, v1] of Object.entries(agentResult)) {
    if (typeof v1 !== "object" || v1 === null) continue
    mappedAgents.set(id, toV2AgentInfo(id, v1 as Record<string, unknown>))
  }

  await ctx.agent.transform((editor) => {
    for (const [id, mapped] of mappedAgents) {
      editor.update(id, (agent) => {
        Object.assign(agent, mapped)
      })
    }
    if (defaultAgent !== undefined) editor.default(defaultAgent)
  })

  log("[v2] agents registered", { agentCount: mappedAgents.size, defaultAgent })
}
