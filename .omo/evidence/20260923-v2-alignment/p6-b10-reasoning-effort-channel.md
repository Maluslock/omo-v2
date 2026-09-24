# `reasoningEffort` on V2: the channel exists (2026-09-24)

## Why

The parity plan carried one "open" item: the V1 `reasoningEffort` fallback that
`lowerReasoningForModel` produces for models with no declared variants. P6-B6 recorded it as a host
limitation after a probe suggested `context.options` drops it. Re-testing with a strict parse of the
outgoing body showed that conclusion was **wrong about the mechanism**, so this note records the
corrected finding and the experiments behind it.

## Experiment 1 - which option name is honored

Omo-free isolated host, one plugin setting exactly one option on `ctx.session.hook("context")`, then
parsing the outgoing provider body (not a substring search):

```
camelCase  e.options.reasoningEffort = "high"
  wire: {"topLevelKeys": ["model","messages","tools","stream","stream_options","reasoning_effort"],
         "reasoning_effort": "high"}                        <- honored, V2 lowers it to the provider name

snake_case e.options.reasoning_effort = "high"
  wire: {"topLevelKeys": ["model","messages","tools","stream","stream_options"],
         "reasoning_effort": null}                          <- dropped
```

So `reasoningEffort` **is** a typed `context.options` field and V2 maps it to the provider's
`reasoning_effort`. The earlier note conflated the two spellings: the snake case it tested is not the
typed name, and the one `body.includes("reasoning_effort")` hit it dismissed was the real thing.

## Experiment 2 - omo's own chain writes it

In-process trace of the real modules (`resolveCategoryExecution` -> `applySessionPromptParams` ->
`createChatParamsHandler` -> `applyV1ChatParams`), category `{reasoningEffort: "high", temperature: 0.33}`:

```
1. categoryModel:        {"providerID":"deepseek","modelID":"deepseek-v4-pro","reasoningEffort":"high","temperature":0.33}
3. stored prompt params: {"temperature":0.33,"options":{"reasoningEffort":"high"}}
4. handler output:       {"options":{"reasoningEffort":"high"},"temperature":0.33}
5. event.options:        {"temperature":0.33,"reasoningEffort":"high"}
```

Every hop works, so after the P6-B6 `message`-record fix there is nothing left to port for this path.

## Experiment 3 - why a live member request still shows no `reasoning_effort`

Two things decide the live outcome, both omo's own model-capability policy and both shared with V1:

1. **`reasoningEffort` is the deprecated spelling of `reasoning`.** `CategoryConfigSchema` marks it
   `@deprecated Use reasoning instead`, and the config pipeline normalizes it to `reasoning`. The live
   background-agent launch proves it:
   `launch() called with: {"model":{"providerID":"deepseek","modelID":"deepseek-v4-pro","reasoning":"high","temperature":0.33}}`.
   `lowerReasoningForModel("high", deepseek-v4-pro)` then returns `{variant:"high"}` (its capability
   table declares `variants: ["low","medium","high","max"]`), so the **variant** path is used, not the
   effort path - and that variant is applied at request time by the P6-B6 write-back.
2. **Unknown families are dropped on purpose.** For a model with no family and no metadata
   (`deepseek/omo-probe-model`), `lowerReasoningForModel` does return `{reasoningEffort:"high"}`, but
   `resolveCompatibleModelSettings` resolves it as `{value: undefined, reason: "unknown-model-family"}`
   and `chat-params.ts` deletes `options.reasoningEffort`. That guard lives in
   `packages/model-core`, is used by the V1 handler too, and is a deliberate "do not send reasoning
   parameters to a model we know nothing about".

A search across the bundled capability snapshot (2109 models) found **no** model whose capability table
declares `reasoningEfforts` without a `high` variant, which is why the effort path cannot be exercised
end to end on this machine: every model that could receive an effort prefers a declared variant.

## Conclusion

- The `reasoningEffort` fallback is **ported and functional**; the V2 option channel exists and V2
  maps it to the provider's field. There is no host limitation.
- Whether a given model actually receives `reasoning_effort` is decided by omo's capability table
  (variant vs effort vs dropped-for-unknown-family), identically on V1 and V2.
- Nothing to implement. Changing the unknown-family guard would alter V1 behavior as well and is a
  product decision, not a V2 alignment gap.

## Corrections applied

- `p6-b6-chat-params-bridge.md`: the claim that `reasoning_effort` does not pass through is corrected
  to "the snake spelling and arbitrary keys are dropped; the typed camelCase name is honored".
- `docs/superpowers/plans/2026-09-24-omo-v2-full-parity.md`: the row no longer reads "host
  limitation"; it records the measured mechanism.

## Evidence artifacts

- `.omo/tmp/effort-probe/run-camel-only.json`, `run-snake-only.json` (both exit 0, both bodies parsed)
- `.omo/tmp/effort-probe/dump.jsonl` (the body dump of the last run)
- `.omo/tmp/effort-trace.ts`, `.omo/tmp/caps-trace.ts`, `.omo/tmp/find-effort-model.ts` (throwaway
  trace scripts; the numbers they produced are quoted above)
- `.omo/tmp/team-params/run-fallback` transcript and the launch-model log line quoted above
