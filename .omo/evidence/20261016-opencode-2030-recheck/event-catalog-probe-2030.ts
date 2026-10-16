import { appendFileSync } from "node:fs"

// Event-catalog probe, re-run against opencode 2.0.30. Identical in spirit to
// .omo/evidence/20260923-v2-alignment/live-v2-event-catalog-probe.ts (the 2.0.11
// baseline): subscribe to every plugin-visible envelope and record only its
// type, data key names and sessionID - never payload text.
const OUT = process.env.CATALOG_OUT ?? "/tmp/event-catalog-2030.jsonl"
const w = (label: string, payload: unknown) => {
  try {
    appendFileSync(OUT, JSON.stringify({ label, payload }) + "\n")
  } catch {}
}

export default {
  id: "zz-events-2030",
  async setup(ctx: any) {
    try {
      const iter = ctx.event.subscribe({})
      void (async () => {
        for await (const ev of iter) {
          w("event", {
            type: ev?.type,
            dataKeys: ev?.data ? Object.keys(ev.data) : null,
            sessionID: ev?.data?.sessionID ?? null,
          })
        }
      })()
    } catch (e) {
      w("event ERR", String(e))
    }
  },
}
