// packages/omo-opencode/src/v2/register-hook-assembly.ts
import type { Plugin } from "@opencode/plugin"
import type { HookName, OhMyOpenCodeConfig } from "../config"
import { createHooks } from "../create-hooks"
import { createModelCacheState } from "../plugin-state"
import { createPluginInterface } from "../plugin-interface"
import { createSessionCompactingHandler } from "../plugin/session-compacting"
import { log } from "../shared"
import { createFirstMessageVariantGate } from "../shared/first-message-variant"
import { startCompactionEndRestore, type CompactionRestoreHooks } from "./compaction-end-restore"
import { startV2EventSubscription } from "./event-subscription"
import {
  registerOmoCompactionHook,
  registerOmoMessagesHook,
  registerOmoModelRequestHook,
  registerOmoPromptHook,
  registerOmoSystemHook,
  registerOmoToolHooks,
  type HookRegistration,
  type V2SessionHookRegistrar,
  type V2ToolHookRegistrar,
} from "./register-hooks"
import { omoRuntimeKeyFor, resolveOmoRuntime, type OmoRuntime } from "./register-tools"

type V2Ctx = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0]

/**
 * Assemble omo's V1 hooks and register the mapped ones onto the V2 hook domains.
 *
 * Mirrors the V1 wiring in `testing/create-plugin-module.ts` (managers → tools → hooks →
 * plugin interface) but shares the runtime with `registerOmoTools` so a single `setup` never
 * builds two manager sets or two tool registries.
 *
 * Registered here: `event.subscribe`, `tool.hook(execute.before|execute.after)`,
 * `session.hook(prompt)` for `chat.message`, `session.hook(context)` for both the messages and
 * system transforms, and `session.hook(compaction)`.
 *
 * Not registered (documented gaps, see the P3 findings): `chat.params`/`chat.headers` →
 * `session.hook("model.request")`, `tool.definition`, `command.execute.before`,
 * `experimental.compaction.autocontinue`, `permission.hook("evaluate")`, and
 * `shell.hook("create.before")`.
 */

export type RegisterHooksDeps = {
  readonly createHooks?: typeof createHooks
  readonly createPluginInterface?: typeof createPluginInterface
  readonly createSessionCompactingHandler?: typeof createSessionCompactingHandler
  readonly createFirstMessageVariantGate?: typeof createFirstMessageVariantGate
  readonly createModelCacheState?: typeof createModelCacheState
  /** Test seam: replaces the shared runtime lookup. */
  readonly resolveRuntime?: typeof resolveOmoRuntime
}

type CachedHookTearDown = { readonly dispose: () => Promise<void> }

const hookCache = new Map<string, CachedHookTearDown>()

/** Test seam: clears the memoized hook registrations (production never calls this). */
export function resetOmoHookCache(): void {
  hookCache.clear()
}

function hasV2HookDomains(ctx: V2Ctx): boolean {
  return typeof ctx.event?.subscribe === "function"
    || typeof ctx.tool?.hook === "function"
    || typeof ctx.session?.hook === "function"
}

function buildShimmedContext(runtime: OmoRuntime, directory: string): unknown {
  return { directory, client: runtime.client }
}

async function registerSessionHooks(
  ctx: V2Ctx,
  disposals: Array<() => Promise<void>>,
  handlers: ReturnType<typeof createPluginInterface>,
  compaction: ReturnType<typeof createSessionCompactingHandler>,
): Promise<void> {
  const session = ctx.session
  if (typeof session?.hook !== "function") return
  const registrar: V2SessionHookRegistrar = (name, callback) =>
    session.hook(name, callback as never) as Promise<HookRegistration>

  const registrations: HookRegistration[] = []
  const chatMessage = handlers["chat.message"]
  if (typeof chatMessage === "function") {
    registrations.push(await registerOmoPromptHook(registrar, chatMessage as never))
  }
  const messages = handlers["experimental.chat.messages.transform"]
  if (typeof messages === "function") {
    registrations.push(await registerOmoMessagesHook(registrar, messages as never))
  }
  const system = handlers["experimental.chat.system.transform"]
  if (typeof system === "function") {
    registrations.push(await registerOmoSystemHook(registrar, system as never))
  }
  const chatParams = handlers["chat.params"]
  if (typeof chatParams === "function") {
    registrations.push(await registerOmoModelRequestHook(registrar, chatParams as never))
  }
  registrations.push(await registerOmoCompactionHook(registrar, compaction as never))
  for (const registration of registrations) disposals.push(() => registration.dispose())
}

async function registerToolHooks(
  ctx: V2Ctx,
  disposals: Array<() => Promise<void>>,
  handlers: ReturnType<typeof createPluginInterface>,
): Promise<void> {
  const tool = ctx.tool
  if (typeof tool?.hook !== "function") return
  const registrar: V2ToolHookRegistrar = (name, callback) =>
    tool.hook(name, callback as never) as Promise<HookRegistration>
  const registrations = await registerOmoToolHooks(registrar, {
    before: handlers["tool.execute.before"] as never,
    after: handlers["tool.execute.after"] as never,
  })
  for (const registration of registrations) disposals.push(() => registration.dispose())
}

function registerEventStream(
  ctx: V2Ctx,
  disposals: Array<() => Promise<void>>,
  handlers: ReturnType<typeof createPluginInterface>,
): void {
  const event = ctx.event
  if (typeof event?.subscribe !== "function") return
  const dispatch = handlers.event
  if (typeof dispatch !== "function") return
  const subscription = startV2EventSubscription({
    subscribe: (options) => event.subscribe(options) as AsyncIterable<unknown>,
    dispatch: (input) => dispatch(input as never),
  })
  disposals.push(() => subscription.dispose())
}

/**
 * Run omo's post-compaction state restore off `session.compaction.ended`.
 *
 * V1 received this through `experimental.compaction.autocontinue`, which V2 does not have. The hook
 * has no place to answer "resume the turn", so only the omo-owned state work moved.
 */
function registerCompactionEndRestore(
  ctx: V2Ctx,
  disposals: Array<() => Promise<void>>,
  hooks: CompactionRestoreHooks,
): void {
  const event = ctx.event
  if (typeof event?.subscribe !== "function") return
  const subscription = startCompactionEndRestore({
    subscribe: (options) => event.subscribe(options) as AsyncIterable<unknown>,
    hooks,
  })
  disposals.push(() => subscription.dispose())
}

/** Register omo's hooks on the V2 domains. Idempotent per `(directory, context, config)`. */
export async function registerOmoHooks(
  ctx: V2Ctx,
  pluginConfig: OhMyOpenCodeConfig,
  deps: RegisterHooksDeps = {},
): Promise<void> {
  if (!hasV2HookDomains(ctx)) {
    log("[v2] hook registration skipped", { reason: "no V2 hook domain available" })
    return
  }

  const key = omoRuntimeKeyFor(ctx, pluginConfig)
  if (hookCache.has(key)) return

  const directory = ctx.location.directory
  for (const [existingKey, entry] of [...hookCache]) {
    if (!existingKey.startsWith(`${directory}\u0000`)) continue
    hookCache.delete(existingKey)
    await entry.dispose().catch(() => {})
  }

  const runtime = await (deps.resolveRuntime ?? resolveOmoRuntime)(ctx, pluginConfig)
  const createHooksFn = deps.createHooks ?? createHooks
  const createPluginInterfaceFn = deps.createPluginInterface ?? createPluginInterface
  const createCompactingFn = deps.createSessionCompactingHandler ?? createSessionCompactingHandler
  const createGateFn = deps.createFirstMessageVariantGate ?? createFirstMessageVariantGate
  const createModelCacheStateFn = deps.createModelCacheState ?? createModelCacheState

  const shimmedCtx = buildShimmedContext(runtime, directory) as never
  const disabledHooks = new Set(pluginConfig.disabled_hooks ?? [])
  const hooks = createHooksFn({
    ctx: shimmedCtx,
    pluginConfig,
    modelCacheState: createModelCacheStateFn(),
    backgroundManager: runtime.managers.backgroundManager,
    modelFallbackControllerAccessor: runtime.managers.modelFallbackControllerAccessor,
    monitorManager: runtime.managers.monitorManager,
    isHookEnabled: (hookName: HookName) => !disabledHooks.has(hookName),
    safeHookEnabled: pluginConfig.experimental?.safe_hook_creation ?? true,
    mergedSkills: runtime.toolsResult.mergedSkills,
    availableSkills: runtime.toolsResult.availableSkills,
  })

  const handlers = createPluginInterfaceFn({
    ctx: shimmedCtx,
    pluginConfig,
    firstMessageVariantGate: createGateFn(),
    managers: runtime.managers,
    hooks,
    tools: runtime.toolsResult.filteredTools,
  })

  const disposals: Array<() => Promise<void>> = []
  registerEventStream(ctx, disposals, handlers)
  registerCompactionEndRestore(ctx, disposals, hooks)
  await registerToolHooks(ctx, disposals, handlers)
  await registerSessionHooks(ctx, disposals, handlers, createCompactingFn(hooks))
  disposals.push(async () => hooks.disposeHooks())

  hookCache.set(key, {
    dispose: async () => {
      for (const dispose of disposals) await dispose().catch(() => {})
    },
  })

  log("[v2] hooks registered", { registered: disposals.length })
}
