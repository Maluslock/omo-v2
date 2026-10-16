// packages/omo-opencode/src/v2/hook-mapping.ts
import { isRecord } from "../shared"

/**
 * V2 → V1 event-shape adapters.
 *
 * V2 emits a flat event envelope (`{id, created, type, location, data, durable?}`) while V1's
 * `event` hook receives `{event: {type, properties}}`. omo's event handlers key off V1 event
 * names and read `event.properties` (`sessionID`, `info`, `status`, `error`), so this module
 * rebuilds that pair.
 *
 * Only the lifecycle subset omo actually consumes is mapped; anything else returns `undefined`
 * and is dropped rather than mis-dispatched. The V2 vocabulary is ~130 types (see
 * `docs/superpowers/notes/2026-09-23-v2-hook-injection-findings.md`).
 *
 * One mapping is a synthesis, not a rename: V2 has no `message.updated`, so it is rebuilt from
 * `session.step.started` + `session.step.ended` (`createV1EventMapper`), which is what keeps the
 * `message.updated`-keyed hooks (preemptive compaction and friends) alive on V2.
 *
 * Verified against a live `GET /api/event` capture on opencode v2.0.11 for `session.created`, and
 * against a full-catalog live capture for the turn envelope (`live-v2-event-catalog.md`: one prompt
 * emits `session.execution.started` -> `session.execution.succeeded` and never `session.idle`);
 * the remaining mappings are derived from `@opencode/schema@2.0.11` event definitions and are
 * pinned by unit tests until a live retry/error event can be captured.
 */

export type V1EventInput = {
  event: { type: string; properties: Record<string, unknown> }
}

/** V2 event type → V1 event type for every mapped event. */
export const V2_EVENT_TO_V1: Readonly<Record<string, string>> = Object.freeze({
  "session.created": "session.created",
  "session.deleted": "session.deleted",
  // V2 has no `session.idle` (and no `session.status`): a live capture of the whole event catalog
  // for one prompt shows the turn envelope is `session.execution.started` ->
  // `session.execution.succeeded`, with no idle event at all. See
  // `live-v2-event-catalog.md`. Without this mapping every V1 idle-keyed omo hook is dead on V2,
  // which is why team member status never left `running` and live delivery never fired.
  "session.execution.succeeded": "session.idle",
  "session.compaction.ended": "session.compacted",
  // Kept for hosts that do emit them; harmless when absent.
  "session.idle": "session.idle",
  "session.status": "session.status",
  "session.execution.failed": "session.error",
  "session.step.failed": "session.error",
  "session.compacted": "session.compacted",
  "session.retry.scheduled": "session.status",
  "file.edited": "file.edited",
  "permission.asked": "permission.asked",
  "permission.replied": "permission.replied",
  // `message.updated` is not a V2 event (it exists only in the V1 namespace of `@opencode/schema`).
  // V2 reports one assistant step as `session.step.started` (provider, model, agent, dispatch time)
  // and `session.step.ended` (finish, tokens, cost); omo's V1 handlers read
  // `message.updated.info.{id,sessionID,role,finish,tokens,providerID,modelID,agent}`, so both are
  // mapped and merged into the V1 message view. Preemptive compaction, runtime fallback, the todo
  // continuation enforcer, notifications and the anthropic recovery hook are all dead on V2 without
  // this — their `tokenCache`/state is only ever filled from `message.updated`.
  "session.step.started": "message.updated",
  "session.step.ended": "message.updated",
})

/**
 * Identity captured when a step starts, merged into the `message.updated` its end produces.
 * `session.step.ended` carries finish/tokens/cost but no provider or model, so the two halves of a
 * step have to be correlated by `assistantMessageID`.
 */
type LinkedStep = {
  readonly providerID?: string
  readonly modelID?: string
  readonly agent?: string
  readonly created?: number
}

/** How many unfinished steps the mapper remembers before dropping the oldest. */
const DEFAULT_MAX_PENDING_STEPS = 64

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function assistantMessageIDOf(data: Record<string, unknown>): string | undefined {
  const value = data.assistantMessageID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** The provider/model/agent a `session.step.started` payload announces. */
function linkedStepOf(data: Record<string, unknown>): LinkedStep {
  const model = isRecord(data.model) ? data.model : undefined
  const providerID = stringField(model, "providerID")
  const modelID = stringField(model, "id")
  const agent = stringField(data, "agent")
  const started = numberField(data, "started")
  return {
    ...(providerID !== undefined ? { providerID } : {}),
    ...(modelID !== undefined ? { modelID } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(started !== undefined ? { created: started } : {}),
  }
}

function identityFields(linked: LinkedStep | undefined): Record<string, unknown> {
  if (linked === undefined) return {}
  return {
    ...(linked.providerID !== undefined ? { providerID: linked.providerID } : {}),
    ...(linked.modelID !== undefined ? { modelID: linked.modelID } : {}),
    ...(linked.agent !== undefined ? { agent: linked.agent } : {}),
  }
}

function sessionIDOf(data: Record<string, unknown>): string | undefined {
  const value = data.sessionID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

type BuildContext = {
  /** Identity captured from the matching `session.step.started`; only `session.step.ended` uses it. */
  readonly linked?: LinkedStep
  /** The envelope's own `created` timestamp, used when the payload carries no time. */
  readonly eventCreated: number
}

function buildProperties(
  v2Type: string,
  data: Record<string, unknown>,
  context: BuildContext,
): Record<string, unknown> | undefined {
  const sessionID = sessionIDOf(data)

  switch (v2Type) {
    case "session.created":
      if (sessionID === undefined) return undefined
      return {
        info: {
          id: sessionID,
          ...(typeof data.title === "string" ? { title: data.title } : {}),
          ...(typeof data.parentID === "string" ? { parentID: data.parentID } : {}),
        },
      }
    case "session.deleted":
      if (sessionID === undefined) return undefined
      return { info: { id: sessionID } }
    case "session.idle":
    case "session.compacted":
    case "session.execution.succeeded":
    case "session.compaction.ended":
      if (sessionID === undefined) return undefined
      return { sessionID }
    case "session.status":
      if (sessionID === undefined) return undefined
      // V2 `data` carries the status payload; keep the whole record when no explicit field exists.
      return { sessionID, status: data.status ?? data }
    case "session.execution.failed":
    case "session.step.failed":
      if (sessionID === undefined) return undefined
      return { sessionID, error: data.error ?? data }
    case "session.retry.scheduled":
      if (sessionID === undefined) return undefined
      return {
        sessionID,
        status: {
          type: "retry",
          ...(typeof data.attempt === "number" ? { attempt: data.attempt } : {}),
          ...(typeof data.next === "number" ? { next: data.next } : {}),
          ...(typeof data.message === "string" ? { message: data.message } : {}),
        },
      }
    // A step starts as the V1 assistant message appears: identity (provider/model/agent) and the
    // dispatch time, and deliberately no `finish` — V1 emitted `message.updated` for a message the
    // moment it existed, long before the model finished, and handlers tolerate that partial view.
    case "session.step.started": {
      const id = assistantMessageIDOf(data)
      if (id === undefined || sessionID === undefined) return undefined
      const linked = linkedStepOf(data)
      return {
        info: {
          id,
          sessionID,
          role: "assistant",
          ...identityFields(linked),
          time: { created: linked.created ?? numberField(data, "started") ?? context.eventCreated },
        },
      }
    }
    // A step ends as the V1 assistant message completes: same identity plus the fields the V1
    // handlers gate on (`finish`, `tokens`, `cost`).
    case "session.step.ended": {
      const id = assistantMessageIDOf(data)
      if (id === undefined || sessionID === undefined) return undefined
      const linked = context.linked
      return {
        info: {
          id,
          sessionID,
          role: "assistant",
          ...identityFields(linked),
          ...(data.finish !== undefined ? { finish: data.finish } : {}),
          ...(isRecord(data.tokens) ? { tokens: data.tokens } : {}),
          ...(data.cost !== undefined ? { cost: data.cost } : {}),
          time: {
            created: linked?.created ?? context.eventCreated,
            completed: numberField(data, "ended") ?? context.eventCreated,
          },
        },
      }
    }
    default:
      return Object.keys(data).length > 0 ? data : {}
  }
}

function convert(event: unknown, linked: LinkedStep | undefined, now: () => number): V1EventInput | undefined {
  if (!isRecord(event)) return undefined
  const v2Type = event.type
  if (typeof v2Type !== "string") return undefined
  const v1Type = V2_EVENT_TO_V1[v2Type]
  if (v1Type === undefined) return undefined
  const data = isRecord(event.data) ? event.data : {}
  const eventCreated = numberField(event, "created") ?? now()
  const properties = buildProperties(v2Type, data, {
    ...(linked !== undefined ? { linked } : {}),
    eventCreated,
  })
  if (properties === undefined) return undefined
  return { event: { type: v1Type, properties } }
}

/**
 * Convert one V2 event envelope into the V1 `EventInput` shape, or `undefined` when the event is
 * unmapped (dropped) or malformed.
 *
 * Stateless: a `session.step.ended` converted here has no provider/model/agent, because that
 * identity arrives on the earlier `session.step.started`. Streams must use
 * `createV1EventMapper()` to get the correlated view.
 */
export function toV1Event(event: unknown): V1EventInput | undefined {
  return convert(event, undefined, Date.now)
}

export type V1EventMapperOptions = {
  /** Clock used when an envelope carries no `created`. Default `Date.now`. */
  readonly now?: () => number
  /** Unfinished steps to remember before the oldest is dropped. Default {@link DEFAULT_MAX_PENDING_STEPS}. */
  readonly maxPendingSteps?: number
}

export type V1EventMapper = {
  readonly toV1Event: (event: unknown) => V1EventInput | undefined
}

/**
 * A stateful `toV1Event`: remembers each `session.step.started` by `assistantMessageID` so the
 * `message.updated` synthesized from the matching `session.step.ended` carries the provider, model
 * and agent that only the start event knew. Pending steps are consumed on the end event and capped,
 * so a stream that loses an end event cannot grow the map without bound.
 */
export function createV1EventMapper(options: V1EventMapperOptions = {}): V1EventMapper {
  const pending = new Map<string, LinkedStep>()
  const now = options.now ?? Date.now
  const maxPendingSteps = options.maxPendingSteps ?? DEFAULT_MAX_PENDING_STEPS

  return {
    toV1Event: (event: unknown): V1EventInput | undefined => {
      if (!isRecord(event)) return undefined
      const v2Type = event.type
      if (typeof v2Type !== "string" || V2_EVENT_TO_V1[v2Type] === undefined) return undefined
      const data = isRecord(event.data) ? event.data : {}
      const id = assistantMessageIDOf(data)

      if (v2Type === "session.step.started" && id !== undefined) {
        pending.set(id, linkedStepOf(data))
        while (pending.size > maxPendingSteps) {
          const oldest = pending.keys().next()
          if (oldest.done === true) break
          pending.delete(oldest.value)
        }
        return convert(event, undefined, now)
      }

      if (v2Type === "session.step.ended" && id !== undefined) {
        const linked = pending.get(id)
        pending.delete(id)
        return convert(event, linked, now)
      }

      return convert(event, undefined, now)
    },
  }
}

/** Whether an event type is mapped (used by the subscription loop to skip early). */
export function isMappedV2Event(event: unknown): boolean {
  return isRecord(event) && typeof event.type === "string" && event.type in V2_EVENT_TO_V1
}
