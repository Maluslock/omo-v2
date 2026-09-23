// packages/omo-opencode/src/v2/register-tools.ts
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { createManagers } from "../create-managers"
import { createRuntimeTmuxConfig } from "../create-runtime-tmux-config"
import { createTools } from "../create-tools"
import { registerManagerForCleanup, unregisterManagerForCleanup } from "../features/background-agent/process-cleanup"
import { createModelCacheState } from "../plugin-state"
import { log } from "../shared"
import { ArgSchemaProvenanceError, toV2Tool } from "./tool-mapping"

type V2Ctx = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0]

const NAMESPACE = "omo"

/**
 * Tools that dereference the V1 plugin `client` at execute time. V2 exposes no `client`
 * on its plugin `Context`, so these cannot work here: advertising them would surface a
 * tool that throws/degrades on every call. They are omitted from the V2 tool registry.
 *
 * Derived from grepping client usage in the V1 tool factories:
 * - `call_omo_agent` — `resolveCallableAgents(ctx.client)`, completion poller.
 * - `look_at` — `session-poller` reads `client.session.status/messages/abort`.
 * - `task` (delegate-task) — `options.client` for parent context/config/model list.
 * - `background_output` — `client.session.messages` for task output.
 * - `background_cancel` — grouped with `background_*` (its own client use is unused; kept
 *   out for consistency so no background surface is advertised without a client).
 * - `session_*` — `setStorageClient(ctx.client)` plus SDK session reads.
 * - `task_create`/`task_update` — `todo-sync` reads `ctx.client.session.todo`.
 * - `skill`/`skill_mcp` — host skill resolution (`readRuntimeHostSkills(ctx.client)`,
 *   native-skills client) and the fail-closed `ctx.ask` permission path.
 * - `monitor_*` — monitor manager is constructed from the client.
 * - `team_*` — every team tool factory receives `ctx.client`.
 *
 * Client-free tools (`grep`, `glob`, `edit`, `interactive_bash`, goal tools) stay
 * registered: grep/glob only need `directory`, hashline `edit` guards `pluginCtx?.client`,
 * and the goal tools are pure filesystem state.
 */
export const CLIENT_DEPENDENT_TOOLS: ReadonlySet<string> = new Set([
  "call_omo_agent",
  "look_at",
  "task",
  "background_output",
  "background_cancel",
  "session_list",
  "session_read",
  "session_search",
  "session_info",
  "task_create",
  "task_update",
  "skill",
  "skill_mcp",
  "monitor_start",
  "monitor_stop",
  "monitor_list",
  "monitor_output",
  "team_create",
  "team_delete",
  "team_shutdown_request",
  "team_approve_shutdown",
  "team_reject_shutdown",
  "team_send_message",
  "team_task_create",
  "team_task_list",
  "team_task_update",
  "team_task_get",
  "team_status",
  "team_list",
])

type RegisterToolsDeps = {
  readonly createManagers: (args: Parameters<typeof createManagers>[0]) => ReturnType<typeof createManagers>
  readonly createTools: (args: Parameters<typeof createTools>[0]) => ReturnType<typeof createTools>
}

const defaultDeps: RegisterToolsDeps = { createManagers, createTools }

/**
 * Order-independent serialization so the cache key is stable regardless of JSON key order.
 * `pluginConfig` is plain JSON-derived data, so no functions/cycles are expected.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`
}

/**
 * `createManagers` has process-global side effects: it starts a non-unref'd TUI heartbeat
 * interval, constructs a BackgroundManager, and registers a process-level shutdown closure.
 * `setup` can run more than once (reloads), so managers are memoized per directory **and
 * construction-relevant config**. The cache holds at most one live manager set per directory:
 * when the fingerprint changes, the previous set is disposed and its global shutdown closure
 * unregistered before fresh managers are built, so reloads cannot pile up heartbeat intervals,
 * pollers, or shutdown handlers.
 */
type LifecycleTarget = { shutdown: () => void | Promise<void> }

type CachedManagers = {
  managers: ReturnType<typeof createManagers>
  cleanupTargets: Set<LifecycleTarget>
}

const managersCache = new Map<string, CachedManagers>()

function managersCacheKey(directory: string, pluginConfig: OhMyOpenCodeConfig): string {
  return `${directory}\u0000${stableStringify(pluginConfig)}`
}

/**
 * Best-effort, awaited teardown of one manager set. `createManagers` exposes no single
 * `dispose`/`stop`/`stopAll` on its returned object; each member has its own lifecycle API:
 * - `tmuxSessionManager.cleanup()`
 * - `backgroundManager.shutdown()`
 * - `skillMcpManager.disconnectAll()`
 * - `monitorManager.shutdown()`
 * - `tuiStateMirror.stop()` (clears the non-unref'd heartbeat interval)
 * The method list also accepts `stop`/`dispose`/`stopAll` so a future/test-seam manager is torn down too.
 */
async function invokeLifecycle(target: unknown, methods: readonly string[]): Promise<void> {
  if (typeof target !== "object" || target === null) return
  for (const method of methods) {
    const fn = (target as Record<string, unknown>)[method]
    if (typeof fn !== "function") continue
    try {
      await Promise.resolve((fn as () => unknown).call(target))
    } catch (error) {
      log(`[v2] manager ${method}() during fingerprint-change dispose error:`, error)
    }
    return
  }
}

async function disposeManagers(entry: CachedManagers): Promise<void> {
  const m = entry.managers as unknown as Record<string, unknown>
  await Promise.all([
    invokeLifecycle(m.tmuxSessionManager, ["cleanup", "stop", "dispose", "stopAll"]),
    invokeLifecycle(m.backgroundManager, ["shutdown", "stop", "dispose", "stopAll"]),
    invokeLifecycle(m.skillMcpManager, ["disconnectAll", "shutdown", "stop", "dispose"]),
    invokeLifecycle(m.monitorManager, ["shutdown", "stop", "dispose", "stopAll"]),
    invokeLifecycle(m.tuiStateMirror, ["stop", "dispose", "shutdown"]),
  ])
  // Unregister the process-global shutdown closure `createManagers` registered for this set.
  for (const target of entry.cleanupTargets) unregisterManagerForCleanup(target)
  entry.cleanupTargets.clear()
}

async function getManagers(
  directory: string,
  pluginConfig: OhMyOpenCodeConfig,
  deps: RegisterToolsDeps,
): Promise<ReturnType<typeof createManagers>> {
  const key = managersCacheKey(directory, pluginConfig)
  const cached = managersCache.get(key)
  if (cached !== undefined) return cached.managers

  // Bound the cache to one entry per directory: evict + dispose any other fingerprint first.
  const prefix = `${directory}\u0000`
  for (const [existingKey, entry] of [...managersCache]) {
    if (!existingKey.startsWith(prefix)) continue
    managersCache.delete(existingKey)
    await disposeManagers(entry)
  }

  const cleanupTargets = new Set<LifecycleTarget>()
  const created = deps.createManagers({
    ctx: { directory } as never,
    pluginConfig,
    tmuxConfig: createRuntimeTmuxConfig(pluginConfig),
    modelCacheState: createModelCacheState(),
    backgroundNotificationHookEnabled: false,
    deps: {
      registerManagerForCleanupFn: (target: LifecycleTarget) => {
        registerManagerForCleanup(target)
        cleanupTargets.add(target)
      },
    },
  })
  managersCache.set(key, { managers: created, cleanupTargets })
  return created
}

/** Test seam: clears the memoized managers (production never calls this). */
export function resetOmoManagersCache(): void {
  managersCache.clear()
}

/**
 * Register omo's V1 tool registry into the V2 tool domain.
 *
 * Probed facts this relies on:
 * - V2 `Context` has **no `client`**. `createManagers`/`createTools` construct successfully
 *   with a minimal `{ directory }` and `ctx.client === undefined`; the client is only
 *   dereferenced at execute time, so it is passed through as `undefined` rather than
 *   fabricating a V1 client. Tools that need it are skipped — see `CLIENT_DEPENDENT_TOOLS`.
 * - Effective V2 tool id = `${options.namespace}_${name}` (namespace separator `_`), as
 *   returned by `ctx.tool.list()` and accepted by `editor.get`. Built-ins such as
 *   `glob`/`grep`/`skill` are never shadowed because every omo tool is namespaced.
 *
 * `setup` may run more than once, so registration is idempotent: a tool is only added when
 * `editor.get(id)` is absent and otherwise merged via `editor.update(id, ...)`.
 */
export async function registerOmoTools(
  ctx: V2Ctx,
  pluginConfig: OhMyOpenCodeConfig,
  deps: Partial<RegisterToolsDeps> = {},
): Promise<void> {
  // Guard before assembling managers: a malformed/mock context without the tool domain must
  // not start manager side effects (background polling, TUI heartbeat) for nothing.
  if (typeof ctx.tool?.transform !== "function") {
    log("[v2] tool registration skipped", { reason: "ctx.tool.transform unavailable" })
    return
  }

  const directory = ctx.location.directory
  const resolvedDeps: RegisterToolsDeps = { ...defaultDeps, ...deps }
  const managers = await getManagers(directory, pluginConfig, resolvedDeps)
  const { filteredTools } = await resolvedDeps.createTools({
    ctx: { directory } as never,
    pluginConfig,
    managers,
  })

  // `ToolsRecord` values are typed against @opencode-ai/plugin's vendored zod (4.1.8) while
  // `toV2Tool` is typed against this package's zod (4.4.3). The runtime shape is identical
  // (`args` is a ZodRawShape), so bridge the two declarations without converting the schema.
  type SourceTool = { description: string; args: never; execute: (a: unknown, c: unknown) => Promise<unknown> }

  const registered: string[] = []
  const skipped: string[] = []
  const built = Object.entries(filteredTools).flatMap(([name, def]) => {
    if (CLIENT_DEPENDENT_TOOLS.has(name)) {
      skipped.push(name)
      return []
    }
    registered.push(name)
    try {
      return [toV2Tool(name, def as unknown as SourceTool, { namespace: NAMESPACE, directory })]
    } catch (error) {
      if (error instanceof ArgSchemaProvenanceError) {
        log("[v2] FATAL: refusing to register tool with mismatched arg-schema provenance", {
          name,
          offendingArgs: error.offendingArgs,
        })
      }
      throw error
    }
  })

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

  log("[v2] tools registered", {
    registered: registered.length,
    skipped: skipped.length,
    skippedTools: skipped,
  })
}
