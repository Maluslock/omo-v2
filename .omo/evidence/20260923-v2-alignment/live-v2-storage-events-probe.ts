import { appendFileSync } from "node:fs"
const OUT = "/home/user/omo-v2/.omo/tmp/v2-storage-probe/dump.jsonl"
const w = (label: string, payload: unknown) => { try { appendFileSync(OUT, JSON.stringify({ label, payload }) + "\n") } catch {} }
export default { id: "zz-store", async setup(ctx: any) {
  w("domains", { storage: Object.keys(ctx.storage ?? {}), event: Object.keys(ctx.event ?? {}), rpc: Object.keys(ctx.rpc ?? {}), generate: Object.keys(ctx.generate ?? {}) })
  try {
    const prior = await ctx.storage.get("session-index")
    w("storage.get", prior ?? null)
    await ctx.storage.set("session-index", { marker: "written", at: Date.now() })
    w("storage.set", "ok")
    const scanned = await ctx.storage.scan({})
    w("storage.scan", scanned)
  } catch (e) { w("storage ERR", String(e)) }
  try {
    const iter = ctx.event.subscribe({})
    void (async () => { for await (const ev of iter) { w("event", { type: ev?.type, keys: ev ? Object.keys(ev) : null, location: ev?.location ?? null, dataKeys: ev?.data ? Object.keys(ev.data) : null }) } })()
  } catch (e) { w("event ERR", String(e)) }
} }
