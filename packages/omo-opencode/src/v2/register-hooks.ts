// packages/omo-opencode/src/v2/register-hooks.ts
import { log } from "../shared"
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
