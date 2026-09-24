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

> **Correction (2026-09-24, later probe).** The "unknown key is treated as a provider option" claim
> above is **wrong** for this host and provider. A dedicated probe set `reasoning_effort`, `thinking`,
> `verbosity`, `max_tokens`, `top_k` and a made-up key on `event.options`, then parsed the outgoing
> body: the primary request carried only the typed names it understood (`maxTokens` -> `max_tokens`,
> `topP` -> `top_p`, `temperature`) and dropped every other key. A camelCase `reasoningEffort` also
> did not pass; an earlier `body.includes("reasoning_effort")` hit was a false positive from text in
> the system prompt. So `context.options` is a **closed, typed** surface for this adapter, not an open
> provider-option bag. See `p6-b6-chat-params-bridge.md` for the measurements.

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
- Not proven live here: a real end-to-end clamp value, because no omo config in this environment makes
  the V1 chain set a non-default max output. The mapping is what was broken; that is what the tests
  pin. **Superseded by `p6-b6-chat-params-bridge.md`**, which found that the handler was not running
  at all (the bridge omitted the `message` record the handler requires) and then proved the chain
  end-to-end on a live provider request (`temperature: 0.33`, `top_p: 0.77`).
- Still open (recorded in the parity plan): the V1 `reasoningEffort` fallback that
  `lowerReasoningForModel` produces for models with no declared variants. V2 lowers reasoning to
  `model.variant` at agent registration, and the request-time variant is now applied too (writing
  `event.model.variant` inside `context` is visible to the primary `model.request`/`http.request`);
  the `reasoningEffort` half has no V2 channel, because `context.options` only forwards the typed
  generation fields.
- `chat.headers` (`x-initiator`, Copilot-only) maps to `session.hook("model.request")` per the
  official docs; it is a separate change.
