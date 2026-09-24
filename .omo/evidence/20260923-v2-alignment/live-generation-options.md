# Generation options reach the provider request on V2 (evidence)

Date: 2026-09-24
Probe: omo-free XDG-isolated `opencode run --standalone --model deepseek/deepseek-v4-pro`, with a
plugin that sets `event.options.maxTokens = 4242` / `event.options.temperature = 0.25` in
`ctx.session.hook("context")` and then reads the outgoing body from
`ctx.session.hook("http.request")` (`request.clone().text()`).
Source: `live-generation-options-probe.ts`; raw dump: `live-generation-options.jsonl`.

## Why

The V1 -> V2 bridge wrote V1's `maxOutputTokens` straight into V2 `options`. V2's typed generation
fields are `maxTokens`, `temperature`, `topP`, `topK`, `frequencyPenalty`, `presencePenalty`, `seed`,
`stop` (`@opencode/ai` `GenerationOptionsFields`), and the official migrate-v1 doc shows
`event.options.maxTokens = 8_000`. An unknown key is treated as a provider option, so omo's
max-output clamp (written by `plugin/chat-params.ts`, including its non-positive fallback) did
nothing.

## Observed

Two model requests were made: the auxiliary title request and the primary agent request.

```
wire (title):   contains 4242 = False   contains 0.25 = False
wire (primary): contains 4242 = True    contains 0.25 = True
body head: {"model":"deepseek-v4-pro","messages":[{"role":"system","content":"You are an AI agent running in OpenCode, ...
```

`context` fired with `model.variant = "default"`, confirming the variant is readable on that event.

## What this proves, and what it does not

- Proves the V2 side of the contract: values written to `event.options.maxTokens` / `.temperature`
  are serialized into the provider request body, and auxiliary request kinds do not inherit them
  (the hook ran once, for the primary request).
- The omo side is proven by unit tests: `applyV1ChatParams` now maps V1 `maxOutputTokens` ->
  V2 `maxTokens` (and asserts `maxOutputTokens` is absent), and `toV1ChatParams` seeds the V1
  scalars back from live V2 options so omo's handlers see current values instead of an empty object.
- Not proven live: a real end-to-end clamp value, because no omo config in this environment makes
  the V1 chain set a non-default max output. The mapping is what was broken; that is what the tests
  pin.
- Still open (recorded in the parity plan): the V1 `reasoningEffort` fallback that
  `lowerReasoningForModel` produces for models with no declared variants. V2 lowers reasoning to
  `model.variant` at agent registration, which covers models that declare variants (all of this
  machine's configured models do); the fallback has no V2 home yet.
- `chat.headers` (`x-initiator`, Copilot-only) maps to `session.hook("model.request")` per the
  official docs; it is a separate change.
