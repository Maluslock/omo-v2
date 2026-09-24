# P5-A1 `chat.headers` on V2 — end-to-end evidence (2026-09-24)

The port: V1 `chat.headers` -> `ctx.session.hook("model.request", ...)` (official mapping). omo's only
`chat.headers` handler is Copilot-specific (`github-copilot` / `github-copilot-enterprise`): it sets
`x-initiator: agent` when the current turn was started by an omo-internal prompt, detected by
`OMO_INTERNAL_INITIATOR_MARKER` inside the user message.

V2 does not put a message on `model.request`, so the port remembers the prompt `messageID` from the
`prompt` hook and hands it to the unchanged V1 handler, which resolves the message through the shim's
`session.message` (added earlier in `25ed701`). Auxiliary requests (`kind: "title"`) are skipped,
matching V1, which only ever ran for the agent loop.

## Harness

A local HTTP sink (`.omo/tmp/chat-headers-probe/sink.py`) records every request's headers, and the
isolated config defines the provider **`github-copilot`** pointed at that sink via
`aisdk:@ai-sdk/openai-compatible`. Two sessions were created with an explicit
`{providerID: "github-copilot", id: "gpt-4"}` model (an API-created session without an explicit model
falls back to the built-in provider and never reaches the sink - that is what the first attempt hit).

- session A: `Reply with exactly PLAIN_OK`
- session B: `<!-- OMO_INTERNAL_INITIATOR --> Reply with exactly INTERNAL_OK`

Raw: `live-chat-headers.jsonl`, counts in `live-chat-headers-summary.md`.

## Observed

| request kind | marker in body | x-initiator | count |
|---|---|---|---|
| primary | false | `None` | 4 |
| primary | true | `agent` | 3 |
| title | false | `agent` | 2 |
| title | true | `agent` | 2 |

Reading:

- **Primary requests differ exactly by the marker**: without it no header (4 requests), with it
  `x-initiator: agent` (3 requests). That is omo's handler, and it is the behaviour V1 had.
- **Title requests carry `x-initiator: agent` regardless of the marker.** That is not omo: our hook
  returns before the handler for `kind !== "primary"`. It is the host's own Copilot handling, which
  matches V1's comment that "OpenCode's copilot fetch wrapper already sets x-initiator based on the
  actual request body content" - and the reason V1 refuses to override when
  `@ai-sdk/github-copilot` is active.

## Limits

- This machine has no real Copilot provider; the sink is a plain OpenAI-compatible endpoint, so the
  evidence is the emitted HTTP headers, not a Copilot API acceptance.
- The sink does not implement SSE streaming, so the sessions show the user message but no assistant
  text. That is a property of the sink, not of the header path.
- Copilot-specific means zero runtime effect on this machine's configured providers; the value is
  parity plus a live proof that the mechanism works.
