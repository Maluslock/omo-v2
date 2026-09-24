import { appendFileSync } from "node:fs"
const OUT = "/home/user/omo-v2/.omo/tmp/team-params/dump.jsonl"
const w = (label: string, payload: unknown) => { try { appendFileSync(OUT, JSON.stringify({ label, payload }) + "\n") } catch {} }
export default { id: "zz-body", async setup(ctx: any) {
  await ctx.session.hook("context", (e: any) => {
    w("context", {
      sessionID: e?.sessionID ?? null,
      agent: e?.agent ?? null,
      modelVariant: e?.model?.variant ?? null,
      optionKeys: e?.options ? Object.keys(e.options) : null,
      options: e?.options ?? null,
    })
  })
  await ctx.session.hook("http.request", async (e: any) => {
    try {
      const body = await e.request.clone().text()
      let parsed: any = undefined
      try { parsed = JSON.parse(body) } catch {}
      w("wire", {
        model: parsed?.model ?? null,
        reasoningEffort: parsed?.reasoning_effort ?? parsed?.reasoningEffort ?? null,
        temperature: parsed?.temperature ?? null,
        maxTokens: parsed?.max_tokens ?? parsed?.maxTokens ?? null,
        topP: parsed?.top_p ?? null,
        bodyHasReasoningEffort: body.includes("reasoning_effort") || body.includes("reasoningEffort"),
      })
    } catch (err) { w("wire ERR", String(err)) }
  })
} }
