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
})

function sessionIDOf(data: Record<string, unknown>): string | undefined {
  const value = data.sessionID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function buildProperties(v2Type: string, data: Record<string, unknown>): Record<string, unknown> | undefined {
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
    default:
      return Object.keys(data).length > 0 ? data : {}
  }
}

/**
 * Convert one V2 event envelope into the V1 `EventInput` shape, or `undefined` when the event is
 * unmapped (dropped) or malformed.
 */
export function toV1Event(event: unknown): V1EventInput | undefined {
  if (!isRecord(event)) return undefined
  const v2Type = event.type
  if (typeof v2Type !== "string") return undefined
  const v1Type = V2_EVENT_TO_V1[v2Type]
  if (v1Type === undefined) return undefined
  const data = isRecord(event.data) ? event.data : {}
  const properties = buildProperties(v2Type, data)
  if (properties === undefined) return undefined
  return { event: { type: v1Type, properties } }
}

/** Whether an event type is mapped (used by the subscription loop to skip early). */
export function isMappedV2Event(event: unknown): boolean {
  return isRecord(event) && typeof event.type === "string" && event.type in V2_EVENT_TO_V1
}
