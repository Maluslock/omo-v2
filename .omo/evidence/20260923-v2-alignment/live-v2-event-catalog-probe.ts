import { appendFileSync } from "node:fs"
const OUT = "/home/user/omo-v2/.omo/tmp/event-catalog/dump.jsonl"
const w = (label: string, payload: unknown) => { try { appendFileSync(OUT, JSON.stringify({ label, payload }) + "\n") } catch {} }
export default { id: "zz-events", async setup(ctx: any) {
  try {
    const iter = ctx.event.subscribe({})
    void (async () => { for await (const ev of iter) {
      w("event", { type: ev?.type, dataKeys: ev?.data ? Object.keys(ev.data) : null, sessionID: ev?.data?.sessionID ?? null })
    } })()
  } catch (e) { w("event ERR", String(e)) }
} }
