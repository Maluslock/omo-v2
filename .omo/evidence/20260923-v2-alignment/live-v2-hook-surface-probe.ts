import { appendFileSync } from "node:fs"
const OUT = "/home/user/omo-v2/.omo/tmp/aisdk-probe/dump.jsonl"
const w = (label: string, payload: unknown) => {
  try { appendFileSync(OUT, JSON.stringify({ label, payload }) + "\n") } catch {}
}
const shape = (o: any) => {
  if (o === null || o === undefined) return String(o)
  if (typeof o !== "object") return typeof o
  return { keys: Object.keys(o).sort(), sample: JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "function" ? "[fn]" : v))) }
}
export default { id: "zz-aisdk", async setup(ctx: any) {
  try { await ctx.session.hook("model.request", (i: any) => { w("model.request", shape(i)) }) } catch (e) { w("model.request ERR", String(e)) }
  try { await ctx.session.hook("http.request", (i: any) => { w("http.request", { keys: Object.keys(i).sort(), url: i?.request?.url, method: i?.request?.method, headerKeys: i?.request?.headers ? [...i.request.headers.keys()] : null }) }) } catch (e) { w("http.request ERR", String(e)) }
  try { await ctx.aisdk.hook("sdk", (i: any) => { w("aisdk.sdk", { model: i?.model ?? null, package: i?.package, optionKeys: i?.options ? Object.keys(i.options).sort() : null, hasSdk: i?.sdk !== undefined }) }) } catch (e) { w("aisdk.sdk ERR", String(e)) }
  try { await ctx.aisdk.hook("language", (i: any) => { w("aisdk.language", { model: i?.model ?? null, optionKeys: i?.options ? Object.keys(i.options).sort() : null, optionTypes: i?.options ? Object.fromEntries(Object.entries(i.options).map(([k, v]) => [k, typeof v])) : null, hasLanguage: i?.language !== undefined }) }) } catch (e) { w("aisdk.language ERR", String(e)) }
  try { await ctx.tool.hook("execute.before", (i: any) => { w("tool.execute.before", shape(i)) }) } catch (e) { w("tool.before ERR", String(e)) }
} }
