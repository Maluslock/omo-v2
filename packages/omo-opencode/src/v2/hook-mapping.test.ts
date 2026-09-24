// packages/omo-opencode/src/v2/hook-mapping.test.ts
import { describe, expect, it } from "bun:test"
import { V2_EVENT_TO_V1, isMappedV2Event, toV1Event } from "./hook-mapping"

// Captured verbatim from `GET /api/event` on opencode v2.0.11.
const CAPTURED_SESSION_CREATED = {
  id: "evt_0ccc1d298001Uc3NPHyFnxgSV5",
  created: 1790141649560,
  type: "session.created",
  location: { directory: "/home/user/omo-v2/.omo/probe5" },
  data: {
    sessionID: "ses_f333e2d92ffecADTnfjxs5x0aZ",
    slug: "playful-rocket",
    version: "2.0.11",
    projectID: "7cbcacac0ade4b5da1b1cef75629990dcd0f1eaf",
    subpath: ".omo/probe5",
    title: "evt",
  },
  durable: { aggregateID: "ses_f333e2d92ffecADTnfjxs5x0aZ", seq: 0, version: 1 },
}

describe("toV1Event", () => {
  it("maps the captured session.created envelope to the V1 {event:{type,properties}} shape", () => {
    expect(toV1Event(CAPTURED_SESSION_CREATED)).toEqual({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_f333e2d92ffecADTnfjxs5x0aZ", title: "evt" } },
      },
    })
  })

  it("maps session.idle and session.compacted to their V1 names", () => {
    expect(toV1Event({ type: "session.idle", data: { sessionID: "ses_1" } })).toEqual({
      event: { type: "session.idle", properties: { sessionID: "ses_1" } },
    })
    expect(toV1Event({ type: "session.compacted", data: { sessionID: "ses_1" } })).toEqual({
      event: { type: "session.compacted", properties: { sessionID: "ses_1" } },
    })
  })

  it("maps the real V2 turn-end envelope onto V1 session.idle", () => {
    // V2 never emits `session.idle`; the live catalog capture shows `session.execution.succeeded`
    // is what ends a turn, so the V1 idle hooks depend on this mapping.
    expect(toV1Event({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })).toEqual({
      event: { type: "session.idle", properties: { sessionID: "ses_1" } },
    })
    expect(toV1Event({ type: "session.execution.succeeded", data: {} })).toBeUndefined()
  })

  it("maps the real V2 compaction end event onto V1 session.compacted", () => {
    expect(toV1Event({ type: "session.compaction.ended", data: { sessionID: "ses_1" } })).toEqual({
      event: { type: "session.compacted", properties: { sessionID: "ses_1" } },
    })
  })

  it("maps both V2 failure events onto V1 session.error with the error payload", () => {
    const error = { name: "ProviderError", message: "boom" }
    for (const type of ["session.execution.failed", "session.step.failed"]) {
      expect(toV1Event({ type, data: { sessionID: "ses_1", error } })).toEqual({
        event: { type: "session.error", properties: { sessionID: "ses_1", error } },
      })
    }
  })

  it("synthesizes a retry status from session.retry.scheduled", () => {
    expect(
      toV1Event({ type: "session.retry.scheduled", data: { sessionID: "ses_1", attempt: 2, next: 5000 } }),
    ).toEqual({
      event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "retry", attempt: 2, next: 5000 } } },
    })
  })

  it("passes through V1-native events that exist unchanged in V2", () => {
    expect(toV1Event({ type: "file.edited", data: { file: "/tmp/a.ts" } })).toEqual({
      event: { type: "file.edited", properties: { file: "/tmp/a.ts" } },
    })
    expect(toV1Event({ type: "permission.replied", data: { sessionID: "ses_1", id: "per_1" } })).toEqual({
      event: { type: "permission.replied", properties: { sessionID: "ses_1", id: "per_1" } },
    })
  })

  it("drops unmapped events", () => {
    expect(toV1Event({ type: "server.connected", data: {} })).toBeUndefined()
    expect(toV1Event({ type: "session.text.delta", data: { sessionID: "ses_1" } })).toBeUndefined()
    expect(isMappedV2Event({ type: "server.connected" })).toBe(false)
    expect(isMappedV2Event({ type: "session.idle" })).toBe(true)
  })

  it("drops malformed input instead of throwing", () => {
    expect(toV1Event(null)).toBeUndefined()
    expect(toV1Event("session.idle")).toBeUndefined()
    expect(toV1Event({})).toBeUndefined()
    // A mapped type with no usable session id cannot be dispatched.
    expect(toV1Event({ type: "session.idle", data: {} })).toBeUndefined()
    expect(toV1Event({ type: "session.created", data: { sessionID: "" } })).toBeUndefined()
  })

  it("keeps the rename table self-consistent", () => {
    for (const [v2, v1] of Object.entries(V2_EVENT_TO_V1)) {
      expect(typeof v2).toBe("string")
      expect(v1.startsWith("session.") || v1.includes(".")).toBe(true)
    }
  })
})
