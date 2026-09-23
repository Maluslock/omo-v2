// packages/omo-opencode/src/v2/event-subscription.ts
import { log } from "../shared"
import { toV1Event, type V1EventInput } from "./hook-mapping"

/**
 * Drives omo's V1 `event` handler from the V2 event stream.
 *
 * V2 exposes `ctx.event.subscribe(requestOptions?)` as an `AsyncIterable` of flat event
 * envelopes whose `requestOptions.signal` cancels the underlying stream. This runner consumes
 * that iterable, converts each envelope with `toV1Event`, and dispatches to the assembled V1
 * handler. It never throws into `setup`: stream failures and per-event dispatch failures are
 * logged (per-event isolation mirrors V1's `createEventHookRunner`).
 *
 * `dispose()` aborts the stream and resolves once the loop unwinds. A non-cooperative iterable
 * cannot hold teardown open forever: the wait is bounded and a timeout is logged.
 */

export type V2EventSubscribe = (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>

export type EventSubscription = {
  readonly dispose: () => Promise<void>
  /** Test seam: resolves when the consume loop has unwound. */
  readonly settled: Promise<void>
}

export type EventSubscriptionOptions = {
  readonly subscribe: V2EventSubscribe
  readonly dispatch: (input: V1EventInput) => Promise<void> | void
  readonly onDispatchError?: (error: unknown, input: V1EventInput) => void
  readonly onStreamError?: (error: unknown) => void
  /** Bound on how long `dispose()` waits for the loop to unwind. Default 2000ms. */
  readonly disposeTimeoutMs?: number
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function startV2EventSubscription(options: EventSubscriptionOptions): EventSubscription {
  const controller = new AbortController()
  const disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
  let disposed = false

  const consume = async (): Promise<void> => {
    try {
      for await (const event of options.subscribe({ signal: controller.signal })) {
        const input = toV1Event(event)
        if (input === undefined) continue
        try {
          await options.dispatch(input)
        } catch (error) {
          if (options.onDispatchError !== undefined) {
            options.onDispatchError(error, input)
          } else {
            log("[v2] event dispatch failed", { type: input.event.type, error: describeError(error) })
          }
        }
      }
    } catch (error) {
      // An abort is the expected teardown path, not an error.
      if (controller.signal.aborted) return
      if (options.onStreamError !== undefined) {
        options.onStreamError(error)
      } else {
        log("[v2] event subscription ended with error", { error: describeError(error) })
      }
    }
  }

  const settled = consume()

  return {
    settled,
    dispose: async (): Promise<void> => {
      if (disposed) return
      disposed = true
      controller.abort()

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), disposeTimeoutMs)
      })
      const outcome = await Promise.race([settled.then(() => "settled" as const), timeout])
      if (timer !== undefined) clearTimeout(timer)
      if (outcome === "timeout") {
        log("[v2] event subscription did not unwind within the dispose timeout", { disposeTimeoutMs })
      }
    },
  }
}
