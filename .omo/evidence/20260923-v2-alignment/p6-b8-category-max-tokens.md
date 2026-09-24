# Category `max_tokens` was never read (found by the P6-B6 probe, fixed 2026-09-24)

## Why

`CategoryConfigSchema` documents `max_tokens` and keeps `maxTokens` only as a deprecated alias:

```ts
max_tokens: z.number().int().positive().optional(),
/** @deprecated Use `max_tokens` instead. */
maxTokens: z.number().optional(),
```

`tools/delegate-task/delegated-model-config.ts` `applyCategoryParams` - the single place a
`CategoryConfig` is mapped onto the delegated model - read only the deprecated key:

```ts
...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
```

A repo-wide search confirmed `config.max_tokens` was read nowhere, so a user writing `max_tokens` in
a category got it silently ignored (on V1 and V2 alike; this is not a V2 port gap). It surfaced while
probing the repaired `chat.params` chain: temperature and `top_p` from the category reached the
provider body, `max_tokens` did not.

This is a different key from the fallback-model object (`FallbackModelObjectSchema`, which genuinely
uses `maxTokens` and is untouched).

## What changed

- `delegated-model-config.ts`: `max_tokens` is read first, falling back to the deprecated `maxTokens`,
  matching the documented-first precedence already used for `reasoning` / `reasoningEffort` in the
  same object literal.
- `delegated-model-config.test.ts` (new, 5 cases): the documented key is applied, the deprecated key
  still works, `max_tokens` wins when both are present, neither key leaves the field unset, and a
  missing config returns the base unchanged.

## Live verification, before / after

Same probe and config as the P6-B6 work: an isolated host, real omo dist, `team_mode.enabled`, a
`quick` category with `model: deepseek/deepseek-v4-pro`, `reasoning: "max"`, `temperature: 0.33`,
`top_p: 0.77`, `max_tokens: 4321`; prompt creates a 2-member team, checks status, deletes. The probe
plugin parses the outgoing provider body.

```
BEFORE
   temperature=0.33 top_p=0.77 max_tokens=None   <- the team member's request
   (other 6 requests are lead/title requests, no category tuning)

AFTER
   temperature=0.33 top_p=0.77 max_tokens=4321   <- the team member's request
```

The failing-first unit test (`delegated-model-config.test.ts`) fails on the old code in exactly two
places (`max_tokens` ignored, precedence wrong) and passes after the fix.

## Regression check

- `bun test packages/omo-opencode/src/tools/delegate-task/`: 488 pass, 0 fail.
- `tsgo --noEmit`: exit 0.
- Full suite: 12928 pass / 3 skip / 13 fail - the known pre-existing failures only.

## Why this is enough

- The defect and the fix are pinned by a direct unit test of the mapping function, which is the only
  place the key is consumed.
- The live before/after shows the user-visible effect on the real surface (provider request body)
  with everything else held constant, so the change is attributable to this one line.

## What was omitted

Synthetic probe values only; no user configuration beyond the sandbox copy is recorded.

## Residual risk

- Users who set the deprecated `maxTokens` keep working unchanged, and users who set both now get the
  documented key; anyone who set both expecting the deprecated one to win would see a change, which is
  the intent of the deprecation.
- The value still passes through `resolveCompatibleModelSettings`, so the model's declared output
  limit can clamp it further - that is existing behaviour and is covered by its own tests.
