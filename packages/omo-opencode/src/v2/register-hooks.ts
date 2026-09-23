// packages/omo-opencode/src/v2/register-hooks.ts
import { isRecord, log } from "../shared"
import {
  applyV1ToolAfter,
  applyV1ToolBefore,
  toV1ToolAfter,
  toV1ToolBefore,
  type V1ToolAfterInput,
  type V1ToolAfterOutput,
  type V1ToolBeforeInput,
  type V1ToolBeforeOutput,
} from "./tool-hook-mapping"
import {
  applyV1System,
  toV1System,
  type V1SystemInput,
  type V1SystemOutput,
} from "./system-hook-mapping"
import {
  createRequestMessageOrigins,
  fromV1RequestMessages,
  toV1RequestMessages,
  type V1RequestMessage,
} from "./request-message-mapping"

/**
 * V2 hook registration layer.
 *
 * omo's V1 handlers are (input, output) pairs; the V2 domains expose single mutable events.
 * Each `registerOmo*Hooks` function bridges one domain by adapting the event, invoking the
 * existing V1 handler unchanged, and writing mutations back. Registration returns `dispose`
 * handles so `setup` reloads can tear the hooks down (the same lifecycle `register-tools.ts`
 * applies to managers).
 *
 * Error semantics follow V1:
 * - `execute.before` failures propagate: a guard that throws (write-existing-file-guard, the
 *   background-wait block) must abort the tool call.
 * - `execute.after` failures are isolated: the tool already ran, so a post-processing bug is
 *   logged instead of turning a successful call into an error.
 */

export type HookRegistration = { dispose: () => Promise<void> }

export type V1ToolBeforeHandler = (
  input: V1ToolBeforeInput,
  output: V1ToolBeforeOutput,
) => Promise<void> | void

export type V1ToolAfterHandler = (
  input: V1ToolAfterInput,
  output: V1ToolAfterOutput,
) => Promise<void> | void

export type V2ToolHookRegistrar = (
  name: "execute.before" | "execute.after",
  callback: (event: unknown) => Promise<void>,
) => Promise<HookRegistration>

export type RegisterToolHooksDeps = {
  readonly before?: V1ToolBeforeHandler
  readonly after?: V1ToolAfterHandler
}

export async function registerOmoToolHooks(
  registrar: V2ToolHookRegistrar,
  deps: RegisterToolHooksDeps,
): Promise<HookRegistration[]> {
  const { before, after } = deps
  const registrations: HookRegistration[] = []

  if (before !== undefined) {
    registrations.push(
      await registrar("execute.before", async (event) => {
        const pair = toV1ToolBefore(event)
        if (pair === undefined) return
        await before(pair.input, pair.output)
        applyV1ToolBefore(event, pair.input, pair.output)
      }),
    )
  }

  if (after !== undefined) {
    registrations.push(
      await registrar("execute.after", async (event) => {
        const pair = toV1ToolAfter(event)
        if (pair === undefined) return
        try {
          await after(pair.input, pair.output)
        } catch (error) {
          log("[v2] tool.execute.after hook failed", {
            tool: pair.input.tool,
            error: error instanceof Error ? error.message : String(error),
          })
          return
        }
        applyV1ToolAfter(event, pair.output)
      }),
    )
  }

  return registrations
}

export type V2SessionHookName = "context" | "compaction" | "model.request" | "prompt"

export type V2SessionHookRegistrar = (
  name: V2SessionHookName,
  callback: (event: unknown) => Promise<void>,
) => Promise<HookRegistration>

export type V1SystemTransformHandler = (
  input: V1SystemInput,
  output: V1SystemOutput,
) => Promise<void> | void

/**
 * Register V1 `experimental.chat.system.transform` on the V2 `context` hook. Only the `system`
 * field is bridged here; request `messages` go through `registerOmoMessagesHook`.
 */
export async function registerOmoSystemHook(
  registrar: V2SessionHookRegistrar,
  handler: V1SystemTransformHandler,
): Promise<HookRegistration> {
  return registrar("context", async (event) => {
    const pair = toV1System(event)
    if (pair === undefined) return
    await handler(pair.input, pair.output)
    applyV1System(event, pair.output)
  })
}

export type V1MessagesTransformHandler = (
  input: Record<string, never>,
  output: { messages: V1RequestMessage[] },
) => Promise<void> | void

/**
 * Register V1 `experimental.chat.messages.transform` on the V2 `context` hook. The V1 hooks
 * mutate `output.messages` in place (and may push/splice parts), so the bridge records origins
 * per invocation and rebuilds the V2 message list from the mutated view.
 */
export async function registerOmoMessagesHook(
  registrar: V2SessionHookRegistrar,
  handler: V1MessagesTransformHandler,
): Promise<HookRegistration> {
  return registrar("context", async (event) => {
    if (!isRecord(event) || typeof event.sessionID !== "string") return
    const origins = createRequestMessageOrigins()
    const messages = toV1RequestMessages(event.messages, event.sessionID, origins)
    await handler({}, { messages })
    event.messages = fromV1RequestMessages(messages, origins)
  })
}
