# Bug hunt — every tool-using turn failed on V2 with "OpenAI Chat user messages only support text and media content for now"

Date: 2026-09-23
Host: opencode 2.0.11, provider `deepseek/deepseek-v4-pro` (direct DeepSeek API)

## Symptom

With omo loaded, the FIRST model call of a turn succeeded and the tool ran, but the NEXT call (the
one carrying the tool result) failed:

```
> Sisyphus - ultraworker · deepseek-v4-pro
✱ Glob "*.md" 1 match
Error: OpenAI Chat user messages only support text and media content for now
```

Host log stack:

```
AI.Error: OpenAI Chat user messages only support text and media content for now
    at OpenAIChat.lowerUserMessage
    at OpenAIChat.lowerMessage
    at OpenAIChat.lowerMessages
    at OpenAIChat.fromRequest
    at LLM.compile
```

## Attribution: omo, not the gateway or the provider

Earlier in this session the same error was written off as a gateway (`new-api`) limitation. That was
wrong, and this run corrects it.

| Setup | Result |
|---|---|
| real service, omo loaded, `deepseek/deepseek-v4-pro` | error |
| isolated `--standalone`, **no omo**, same provider config, same prompt | `Glob 1 match` -> `TOOL_OK` |
| isolated `--standalone`, providers copied from the real config **with omo**, same prompt | error reproduced |

Isolation recipe that made this testable: `XDG_CONFIG_HOME` isolates both the config and the global
plugin dir, so `opencode run --standalone` with a copied provider config is omo-free but still has
working models. (Note: plugin loading is lazy; a location only initializes on the first prompt or
command, so probes that merely create a session never load plugins and prove nothing.)

## Bisect

`disabled_hooks` in the project `.omo/omo.jsonc` narrowed it in four runs:

| disabled_hooks | result |
|---|---|
| 16 message/tool-touching hooks | FIXED |
| the 5 tool-result/render ones | FIXED |
| the 11 message-injection ones | still broken |
| **only `tool-pair-validator`** | **FIXED** |

So `tool-pair-validator` was the only hook that mattered.

## Root cause: my V2 -> V1 message projection

`src/v2/request-message-mapping.ts` projects V2 request messages into the V1 `{info, parts}` view the
V1 hooks mutate. A tool call is marked terminal through the OpenCode part shape
`{type: "tool", callID, state: {status: "completed" | "running"}}`, and the projection decided
`hasResult` by looking for a matching `tool-result` **only inside the tool call's own message**.

V2 puts the tool result in its **own message**. So every finished call was projected as `running`,
`tool-pair-validator` concluded the conversation had unmatched tool calls, and it "repaired" it by
injecting a `tool_result` placeholder part (which the hook intentionally writes for the V1/Claude
shape) into a user message. OpenAI-compatible lowering then rejected that user message, because a
user message may only carry text and media.

The old unit-test fixture made this invisible: `V2_MESSAGES` keeps the `tool-call` and its
`tool-result` in the SAME assistant message, so per-message lookup looked correct.

## Fix

`toV1RequestMessages` now collects result ids across the whole request before converting, so a call
whose result arrives in a later message is projected as `completed`.

```ts
const records = messages.filter(isRecord)
const resultIDs = new Set<string>()
for (const message of records) {
  for (const part of (Array.isArray(message.content) ? message.content : [])) {
    if (isRecord(part) && part.type === "tool-result" && typeof part.id === "string") resultIDs.add(part.id)
  }
}
```

`tool-pair-validator` still does its job for a genuinely unresolved call (pinned by a test), it just
no longer fires on healthy ones.

## Verification

New tests in `src/v2/request-message-mapping.test.ts`, using a fixture that matches V2's real split
shape (`V2_SPLIT_TOOL_MESSAGES`):

1. a call whose result arrives in a later message is `completed`;
2. running that request through `createToolPairValidatorHook()` injects nothing, and the only
   `tool_result` present is the genuine one (its payload still contains `1 match`, and the string
   `Tool output unavailable` appears nowhere);
3. a call with no result anywhere is still `running`, so the repair path stays alive.

Live, after `bun build` and with NO `disabled_hooks`:

```
sandbox (providers + omo):   ✱ Glob "*.md" 1 match   -> TOOL_OK
real service (omo via ~/.config/opencode/plugins/omo-local.ts):
  ✱ Glob "*.md" 2 matches
  ✱ Grep "hello" 2 matches                            -> TOOL_OK
```

The real-service run is a two-tool-sequential-call session, so the follow-up request after two
result messages also lowers cleanly.

## Lesson

The V2 -> V1 projection must not assume V1's message grouping. Anything the V1 hooks infer from
message shape (result pairing, terminal state) has to be derived from the whole request, because V2
splits calls and results across messages.
