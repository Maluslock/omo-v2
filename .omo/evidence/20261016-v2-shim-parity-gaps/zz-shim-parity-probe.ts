// .omo/evidence/20261016-v2-shim-parity-gaps/zz-shim-parity-probe.ts
//
// Live probe for the three V2 client-shim parity fixes (see README.md):
//   1. `session.summarize` must map onto the host's `ctx.session.compact`
//      (before the fix it was `undefined` on V2, so omo's preemptive compaction
//      died in a catch block);
//   2. `session.create` must forward `parentID` so subagent sessions link to
//      their parent;
//   3. a V1 tool body must receive the HOST's cancellation signal, not a fresh
//      never-aborting one.
//
// It also runs the production V2 -> V1 event pipeline (`startV2EventSubscription`)
// against the host's live stream, because V2 has no `message.updated` event and the
// synthesis of it (from `session.step.started` / `session.step.ended`) is what keeps
// omo's `message.updated`-keyed hooks alive on V2.
//
// It imports the PRODUCTION modules by path (the same files the build consumes)
// and hands them a REAL plugin context from a live 2.0.30 host, which is the
// link unit tests cannot cover: the mapping is exercised against the actual
// `ctx.session` / tool domain rather than a fake.
//
// Records NDJSON to $SHIM_PROBE_OUT. The summarize target is read at execute
// time from the file named by $SHIM_PROBE_TARGET_FILE, so the runner can create
// a donor session after the server has already started.

import { appendFileSync, readFileSync } from "node:fs"

const OUT = process.env.SHIM_PROBE_OUT ?? "/tmp/shim-parity-probe.jsonl"
const REPO = process.env.SHIM_PROBE_REPO ?? process.cwd()

type Any = any

function record(label: string, payload: Record<string, unknown> = {}): void {
  try {
    appendFileSync(OUT, `${JSON.stringify({ label, ...payload, at: Date.now() })}\n`)
  } catch {
    // The probe must never break the host under test.
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function targetSession(): string {
  const path = process.env.SHIM_PROBE_TARGET_FILE
  if (!path) return ""
  try {
    return readFileSync(path, "utf8").trim()
  } catch {
    return ""
  }
}

export default {
  id: "zz-shim-parity-probe",
  async setup(ctx: Any) {
    record("setup", {
      hasSessionGet: typeof ctx.session?.get,
      hasSessionCreate: typeof ctx.session?.create,
      hasSessionCompact: typeof ctx.session?.compact,
      hasToolTransform: typeof ctx.tool?.transform,
      hasEventSubscribe: typeof ctx.event?.subscribe,
    })

    const { createV1ClientShim } = await import(
      `${REPO}/packages/omo-opencode/src/v2/client-shim.ts`
    )
    const { toV2Tool } = await import(`${REPO}/packages/omo-opencode/src/v2/tool-mapping.ts`)
    const { tool } = await import(`${REPO}/node_modules/@opencode-ai/plugin/dist/index.js`)

    const shim = createV1ClientShim(ctx)
    record("shim", {
      hasCreate: typeof shim.session?.create,
      hasSummarize: typeof shim.session?.summarize,
      hasAbortMethod: typeof shim.session?.abort,
    })

    // Fire and forget: setup must return so the host finishes loading the plugin.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({})) {
          const type = event?.type
          if (typeof type !== "string") continue
          if (
            type.startsWith("session.compaction") ||
            type === "session.execution.started" ||
            type === "session.execution.succeeded" ||
            type === "session.execution.failed"
          ) {
            record("event", { type, sessionID: event?.data?.sessionID ?? null })
          }
        }
      } catch (error) {
        record("event.stream.error", { error: describe(error) })
      }
    })()

    // The production V2 -> V1 pipeline, fed by the host's own stream: a real
    // `startV2EventSubscription` (event-subscription.ts + its stateful mapper) with a recorder in
    // place of omo's assembled V1 handler. V2 has no `message.updated` event, so if these records
    // appear, the synthesis rebuilt it from `session.step.started`/`session.step.ended` on live
    // payloads — which is what the V1 hooks keyed on `message.updated` need to stop being dormant.
    const { startV2EventSubscription } = await import(
      `${REPO}/packages/omo-opencode/src/v2/event-subscription.ts`
    )
    const subscription = startV2EventSubscription({
      subscribe: (options: Any) => ctx.event.subscribe(options ?? {}),
      dispatch: (input: Any) => {
        if (input?.event?.type !== "message.updated") return
        const info = (input?.event?.properties?.info ?? {}) as Record<string, unknown>
        const time = (info.time ?? {}) as Record<string, unknown>
        record("v1event", {
          type: "message.updated",
          id: info.id ?? null,
          sessionID: info.sessionID ?? null,
          role: info.role ?? null,
          finish: info.finish ?? null,
          providerID: info.providerID ?? null,
          modelID: info.modelID ?? null,
          agent: info.agent ?? null,
          hasTokens: info.tokens !== undefined,
          timeCreated: time.created ?? null,
          timeCompleted: time.completed ?? null,
        })
      },
      onDispatchError: (error: Any) => record("v1event.error", { error: describe(error) }),
      onStreamError: (error: Any) => record("v1event.stream.error", { error: describe(error) }),
    })
    void subscription.settled.then(
      () => record("v1event.stream", { settled: true }),
      () => record("v1event.stream", { settled: false }),
    )

    const def = {
      description:
        "Live probe: calls the production V2 client shim (session.create parentID, session.summarize) and waits for the host's abort signal.",
      args: {
        mode: tool.schema.string(),
      },
      async execute(args: Any, context: Any): Promise<string> {
        const mode = String(args?.mode ?? "")
        record("tool.start", {
          mode,
          sessionID: context.sessionID,
          abortIsAbortSignal: context.abort instanceof AbortSignal,
        })

        if (mode === "create-child" || mode === "all") {
          try {
            const response = await shim.session.create({
              body: { parentID: context.sessionID, title: "zz shim probe child" },
            })
            const info = (response?.data ?? {}) as Record<string, unknown>
            record("create.result", {
              error: response?.error === undefined ? null : describe(response.error),
              requestedParentID: context.sessionID,
              id: typeof info.id === "string" ? info.id : null,
              returnedParentID: typeof info.parentID === "string" ? info.parentID : null,
            })
          } catch (error) {
            record("create.result", { threw: describe(error) })
          }
        }

        if (mode === "summarize" || mode === "all") {
          const target = targetSession()
          record("summarize.begin", { target })
          try {
            const response = await shim.session.summarize({ path: { id: target } })
            record("summarize.result", {
              resolved: true,
              error: response?.error === undefined ? null : describe(response.error),
            })
          } catch (error) {
            record("summarize.result", { resolved: false, error: describe(error) })
          }
        }

        if (mode === "wait-abort" || mode === "all") {
          const signal: AbortSignal = context.abort
          record("abort.wait", { aborted: signal.aborted })
          const outcome = await new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve("timeout"), 45_000)
            if (signal.aborted) {
              clearTimeout(timer)
              resolve("aborted")
              return
            }
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer)
                resolve("aborted")
              },
              { once: true },
            )
          })
          record("abort.observed", { outcome, aborted: signal.aborted })
          return `ABORT_${outcome.toUpperCase()}`
        }

        return "PROBE_DONE"
      },
    }

    const wrapped = toV2Tool("zz_shim_probe", def, {
      namespace: "zzprobe",
      directory: ctx.location?.directory ?? process.cwd(),
    })
    await ctx.tool.transform((editor: Any) => {
      editor.add(wrapped)
    })
    record("registered", { name: wrapped?.name ?? null, namespace: "zzprobe" })
  },
}
