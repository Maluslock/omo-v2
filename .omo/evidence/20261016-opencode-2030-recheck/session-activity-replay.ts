// Replays a captured plugin-event dump through the *real* V2 activity tracker,
// so probe #4 reports what the client shim would have answered rather than what
// the probe assumes it would.
//
// `createSessionActivityTracker()` takes an injectable clock; the default is
// `Date.now`, and the replay runs in a few milliseconds, so no entry can expire
// mid-replay. TTL expiry is covered by the co-located unit tests instead.
import { readFileSync } from "node:fs"

import { createSessionActivityTracker } from "../../../packages/omo-opencode/src/v2/session-activity"

type Captured = { readonly type: string; readonly sessionID: string }

function readCaptured(file: string): Captured[] {
  const events: Captured[] = []
  let text = ""
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return events
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof parsed !== "object" || parsed === null) continue
    const payload = (parsed as { payload?: unknown }).payload
    if (typeof payload !== "object" || payload === null) continue
    const { type, sessionID } = payload as { type?: unknown; sessionID?: unknown }
    if (typeof type === "string" && typeof sessionID === "string") events.push({ type, sessionID })
  }
  return events
}

const file = process.argv[2]
const events = file ? readCaptured(file) : []
const tracker = createSessionActivityTracker()
const perSession = new Map<string, { busyEver: boolean; clearedBy: string }>()

for (const event of events) {
  const before = tracker.statuses()
  tracker.observe(event.type, event.sessionID)
  const after = tracker.statuses()
  const wasBusy = Object.prototype.hasOwnProperty.call(before, event.sessionID)
  const isBusy = Object.prototype.hasOwnProperty.call(after, event.sessionID)
  const entry = perSession.get(event.sessionID) ?? { busyEver: false, clearedBy: "none" }
  if (isBusy) entry.busyEver = true
  if (wasBusy && !isBusy) entry.clearedBy = event.type
  perSession.set(event.sessionID, entry)
}

console.log(`REPLAY_FILE=${file === undefined ? "?" : (file.split("/").pop() ?? "?")}`)
console.log(`REPLAY_EVENTS=${events.length}`)
console.log(`REPLAY_STATUSES_AT_END=${Object.keys(tracker.statuses()).join(",") || "none"}`)
for (const [id, entry] of perSession) {
  console.log(`REPLAY_SESSION ${id} busy_ever=${entry.busyEver ? "yes" : "no"} cleared_by=${entry.clearedBy}`)
}
