// packages/omo-opencode/src/v2/event-subscription.test.ts
import { describe, expect, it } from "bun:test"
import { startV2EventSubscription } from "./event-subscription"
import type { V1EventInput } from "./hook-mapping"

const IDLE = { type: "session.idle", data: { sessionID: "ses_1" } }
const UNMAPPED = { type: "server.connected", data: {} }
const CREATED = {
  type: "session.created",
  data: { sessionID: "ses_2", title: "t" },
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Async iterable that yields the given events, then parks until its signal aborts. */
async function* cooperative(events: unknown[], signal: AbortSignal): AsyncGenerator<unknown> {
  for (const event of events) yield event
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

describe("startV2EventSubscription", () => {
  it("dispatches only mapped events, in stream order, and passes an abort signal", async () => {
    const dispatched: V1EventInput[] = []
    let receivedSignal: AbortSignal | undefined

    const subscription = startV2EventSubscription({
      subscribe: (options) => {
        receivedSignal = options?.signal
        return cooperative([IDLE, UNMAPPED, CREATED], options?.signal as AbortSignal)
      },
      dispatch: (input) => {
        dispatched.push(input)
      },
    })

    await sleep(10)
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    expect(dispatched.map((input) => input.event.type)).toEqual(["session.idle", "session.created"])
    expect(dispatched[1]?.event.properties).toEqual({ info: { id: "ses_2", title: "t" } })

    await subscription.dispose()
  })

  it("isolates a dispatch failure and keeps consuming", async () => {
    const dispatched: string[] = []
    const failures: Array<{ error: unknown; type: string }> = []
    let calls = 0

    const subscription = startV2EventSubscription({
      subscribe: (options) => cooperative([IDLE, CREATED], options?.signal as AbortSignal),
      dispatch: (input) => {
        calls += 1
        if (calls === 1) throw new Error("dispatch boom")
        dispatched.push(input.event.type)
      },
      onDispatchError: (error, input) => {
        failures.push({ error, type: input.event.type })
      },
    })

    await sleep(10)
    // The first event threw but the loop continued to the second.
    expect(failures).toHaveLength(1)
    expect(failures[0]?.type).toBe("session.idle")
    expect(dispatched).toEqual(["session.created"])

    await subscription.dispose()
  })

  it("catches a synchronous subscribe failure without rejecting", async () => {
    const streamErrors: unknown[] = []
    const subscription = startV2EventSubscription({
      subscribe: () => {
        throw new Error("stream boom")
      },
      dispatch: () => {},
      onStreamError: (error) => {
        streamErrors.push(error)
      },
    })

    await subscription.settled
    expect(streamErrors).toHaveLength(1)
    await subscription.dispose()
  })

  it("stops consuming and aborts the stream on dispose", async () => {
    let aborted = false
    const dispatched: string[] = []

    const subscription = startV2EventSubscription({
      subscribe: (options) => {
        const signal = options?.signal as AbortSignal
        signal.addEventListener("abort", () => {
          aborted = true
        })
        return cooperative([IDLE], signal)
      },
      dispatch: (input) => {
        dispatched.push(input.event.type)
      },
    })

    await sleep(10)
    expect(dispatched).toEqual(["session.idle"])

    await subscription.dispose()
    expect(aborted).toBe(true)
    await subscription.dispose()
    expect(aborted).toBe(true)
  })

  it("resolves dispose within the timeout even when the stream ignores the abort", async () => {
    async function* stubborn(): AsyncGenerator<unknown> {
      yield IDLE
      await new Promise<void>(() => {
        // Deliberately never resolves and never observes the abort signal.
      })
    }

    const subscription = startV2EventSubscription({
      subscribe: () => stubborn(),
      dispatch: () => {},
      disposeTimeoutMs: 20,
    })

    await sleep(5)
    const started = Date.now()
    await subscription.dispose()
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
