import { appendFileSync } from "node:fs"
const OUT = "/home/user/omo-v2/.omo/tmp/maxtokens-probe/dump.jsonl"
const w = (label: string, payload: unknown) => { try { appendFileSync(OUT, JSON.stringify({ label, payload }) + "\n") } catch {} }
export default { id: "zz-maxtokens", async setup(ctx: any) {
  await ctx.session.hook("context", (e: any) => {
    e.options.maxTokens = 4242
    e.options.temperature = 0.25
    w("set-context-options", { maxTokens: e.options.maxTokens, temperature: e.options.temperature, modelVariant: e?.model?.variant ?? null, kind: e?.kind ?? null })
  })
  await ctx.session.hook("http.request", async (e: any) => {
    try {
      const body = await e.request.clone().text()
      w("wire-body", { maxTokensInBody: body.includes("4242"), temperatureInBody: body.includes("0.25"), snippet: body.slice(0, 200) })
    } catch (err) { w("wire-body ERR", String(err)) }
  })
} }
