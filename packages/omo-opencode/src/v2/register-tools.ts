// packages/omo-opencode/src/v2/register-tools.ts
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { createManagers } from "../create-managers"
import { createRuntimeTmuxConfig } from "../create-runtime-tmux-config"
import { createTools } from "../create-tools"
import { createModelCacheState } from "../plugin-state"
import { log } from "../shared"
import { toV2Tool } from "./tool-mapping"

type V2Ctx = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0]

const NAMESPACE = "omo"

/**
 * Register omo's V1 tool registry into the V2 tool domain.
 *
 * Probed facts this relies on:
 * - V2 `Context` has **no `client`**. `createManagers`/`createTools` construct successfully
 *   with a minimal `{ directory }` and `ctx.client === undefined`; the client is only
 *   dereferenced lazily at execute time, so it is passed through as `undefined` rather than
 *   fabricating a V1 client. Tools that genuinely need the client (e.g. `task`, background
 *   tools, `skill_mcp` host reads) degrade or fail at call time.
 * - Effective V2 tool id = `${options.namespace}_${name}` (namespace separator `_`), as
 *   returned by `ctx.tool.list()` and accepted by `editor.get`. Built-ins such as
 *   `glob`/`grep`/`skill` are therefore never shadowed because every omo tool is namespaced.
 *
 * `setup` may run more than once, so registration is idempotent: a tool is only added when
 * `editor.get(id)` is absent and otherwise merged via `editor.update(id, ...)`.
 */
export async function registerOmoTools(ctx: V2Ctx, pluginConfig: OhMyOpenCodeConfig): Promise<void> {
  // Guard before assembling managers: a malformed/mock context without the tool domain must
  // not start manager side effects (background polling, TUI heartbeat) for nothing.
  if (typeof ctx.tool?.transform !== "function") {
    log("[v2] tool registration skipped", { reason: "ctx.tool.transform unavailable" })
    return
  }

  const directory = ctx.location.directory
  const v1Ctx = { directory } as never
  const tmuxConfig = createRuntimeTmuxConfig(pluginConfig)
  const modelCacheState = createModelCacheState()
  const managers = createManagers({
    ctx: v1Ctx,
    pluginConfig,
    tmuxConfig,
    modelCacheState,
    backgroundNotificationHookEnabled: false,
  })
  const { filteredTools } = await createTools({ ctx: v1Ctx, pluginConfig, managers })

  const entries = Object.entries(filteredTools)
  // `ToolsRecord` values are typed against @opencode-ai/plugin's vendored zod (4.1.8) while
  // `toV2Tool` is typed against this package's zod (4.4.3). The runtime shape is identical
  // (`args` is a ZodRawShape), so bridge the two declarations without converting the schema.
  type SourceTool = { description: string; args: never; execute: (a: unknown, c: unknown) => Promise<unknown> }
  const built = entries.map(([name, def]) =>
    toV2Tool(name, def as unknown as SourceTool, { namespace: NAMESPACE, directory }),
  )

  await ctx.tool.transform((editor) => {
    editor.namespace({ name: NAMESPACE, description: "oh-my-openagent tools" })
    for (const tool of built) {
      // Idempotent: `setup` can run more than once, and the effective id carries the namespace.
      const id = `${NAMESPACE}_${tool.name}`
      const existing = editor.get(id)
      if (existing === undefined) editor.add(tool as never)
      else editor.update(id, (t) => Object.assign(t, tool as never))
    }
  })

  log("[v2] tools registered", { toolCount: built.length })
}
