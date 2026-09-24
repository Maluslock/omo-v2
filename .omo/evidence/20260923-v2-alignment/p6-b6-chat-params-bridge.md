# P6-B6: the V1 `chat.params` chain was dead on V2 (2026-09-24)

## Why

`chat-params.ts` `buildChatParamsInput` requires `{sessionID, agent, model, provider, message}` and
returns `null` when any of them is missing - including `message`, which it demands be a record. The
V2 bridge (`v2/model-request-hook-mapping.ts`) sent `{sessionID, agent, model, provider}` and no
`message` (V2's `context` event has no request message), so **the entire V1 chain no-opped on V2**:

- per-session prompt params stored by the background manager and delegate-task
  (`applySessionPromptParams` -> temperature / topP / maxOutputTokens / reasoningEffort / thinking),
- the model-capability clamp and variant lowering,
- the V1 scalar -> V2 name mapping for max output.

Everything downstream of those (the max-output clamp, subagent tuning, category tuning) was
therefore not applied to any V2 request, for any agent. The bridge's unit tests only asserted the
*shape it produced*, never that the real handler accepted it, so this survived the earlier
"generation options" work.

## What changed

- `v2/model-request-hook-mapping.ts`: `V1ChatParamsInput` gains `message`, and `toV1ChatParams`
  synthesizes it from `event.model.variant` (the only request-scoped carry-over V2 has). The handler
  now accepts the input.
- `applyV1ChatParams` takes the input as an optional third argument and writes a variant the handler
  lowered back onto `event.model.variant` (dropping it when the handler lowered it away).
- `v2/register-hooks.ts`: the "no mutable input.message" gap log is gone; the variant result is
  propagated.
- `v2/chat-params-bridge.test.ts` (new): runs the **real** `createChatParamsHandler` over the bridged
  input and asserts stored session prompt params land in `event.options` under V2 names.
- `v2/model-request-hook-mapping.test.ts`: the synthesized message, the variant write-back, and the
  drop/unchanged cases.
- `live-generation-options.md`: corrected the wrong earlier claim that an unknown `options` key is
  treated as a provider option (it is not - see below).

## Live verification: before / after on the same probe

Probe: isolated host, real omo dist, `team_mode.enabled` with a `quick` category carrying
`temperature: 0.33`, `top_p: 0.77`, `max_tokens: 4321`, `reasoning: "max"`. A second plugin
(`live-v2-provider-body-probe.ts`) registers `ctx.session.hook("context")` and
`ctx.session.hook("http.request")` and parses the outgoing provider body. Prompt: create a 2-member
team, check status, delete. Runner: `.omo/tmp/team-params/run-probe.sh <label>`.

**Before** (built from `5b3e790`, the commit before this fix):

```
provider requests: 7
  temperature=None  top_p=None  max_tokens=None  (x7)
```

**After** (same probe, same config, rebuilt):

```
provider requests: 7
  temperature=None  top_p=None  max_tokens=None
  temperature=None  top_p=None  max_tokens=None
  temperature=0.33  top_p=0.77  max_tokens=None   <- the team member's request
  ... (remaining requests are the lead/title requests)
```

The member's `context` event after the fix shows what omo wrote:

```
{"agent": "Sisyphus-Junior", "optionKeys": ["temperature", "topP"], "options": {"temperature": 0.33, "topP": 0.77}}
```

### `max_tokens` is absent for a different, pre-existing reason

The category sets `max_tokens` (the documented key in `CategoryConfigSchema`), but
`tools/delegate-task/delegated-model-config.ts` `applyCategoryParams` reads only the **deprecated**
`maxTokens` key:

```ts
...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
```

So a user's `max_tokens` never reaches the delegate model on V1 or V2 alike. Recorded as an open item
at the time; **fixed separately in `p6-b8-category-max-tokens.md`** (documented key read first,
deprecated alias as fallback).

### The `context.options` surface is closed and typed

The same probe run answered an open question from the earlier generation-options work. Setting
`reasoning_effort`, `thinking`, `verbosity`, `max_tokens`, `top_k` and a made-up key on
`event.options` produced a primary body whose only extra top-level keys were the typed ones:

```
typed probe:  {"top_p":0.77,"topP":null,"max_tokens":4321,"temperature":0.33}
unknown keys: no reasoning_effort / thinking / verbosity / top_k / custom key in the body
```

An earlier `body.includes("reasoning_effort")` hit was a false positive from text inside the system
prompt, which is why the previous evidence note claimed unknown keys pass through. It does not:
`context.options` forwards `maxTokens -> max_tokens`, `topP -> top_p`, `temperature` (and the rest of
the typed set) and drops everything else.

### The variant write-back is effective

A separate omo-free probe wrote `event.model.variant = "MUTATED_VARIANT"` inside the `context` hook
and read it back in the later hooks:

```
context-before variant=default   context-after variant=MUTATED_VARIANT
model.request variant=MUTATED_VARIANT      <- primary request
http.request  variant=MUTATED_VARIANT
```

So the host reads `event.model.variant` after the context hook, meaning the request-time variant
lowering the V1 chain computes is applied.

## Impact

The fix is not team-specific: `applySessionPromptParams` is called by the background manager on every
subagent launch (`manager.ts:886`, `:1383`, `spawner.ts:106`) and by `delegate-task` and
`call-omo-agent` sync paths, so **every V2 subagent's stored generation params were being dropped**
before this, not just team members'.

## Regression check

- `bun test packages/omo-opencode/src/v2/`: 265 pass, 0 fail.
- `tsgo --noEmit`: exit 0.
- Full suite: 12922 pass / 3 skip / 14 fail. 13 are the known pre-existing failures; the 14th was
  `plugin init performance > stays within the empty project init budget`, which passes in isolation
  (median 84ms, budget met) and only tripped because a `tsgo` run was hogging the machine
  concurrently. Not a regression.

## Why this is enough

- The defect is proved deterministically first: the new bridge test fails on the old code
  (`event.options` stays `{}`).
- The fix is then proved on the real surface with a before/after on the same probe and config, with
  the provider body as the source of truth.
- The two related questions the run raised (the closed `options` surface, variant mutability) were
  measured rather than assumed, and the earlier wrong claim was corrected in place.

## What was omitted

- Only synthetic probe values are recorded; no prompts, model output, or credentials.
- The probe exercises one provider adapter (`aisdk:@ai-sdk/openai-compatible`). The typed-field set is
  shared across adapters, but a provider whose adapter accepts extra options could behave differently.

## Residual risk

- `reasoningEffort` still has no V2 channel, so the V1 fallback for models that declare no variants
  remains inert; those models now get the lowered `model.variant` written back, and the rest of the
  chain (temperature/topP/maxTokens) applies. Recorded in the plan.
- Writing `event.model.variant` from a plugin hook is not in the documented mutable set (only
  `options` and `tools` are), so a future host version could stop honoring it. The fallback path and
  the client-shim variant mapping keep working if that happens.
