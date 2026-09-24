# V2 hook surface — live probe (2026-09-24)

Probe: an omo-free, XDG-isolated `opencode run --standalone --model deepseek/deepseek-v4-pro`
session with a plugin that registers every hook we care about and dumps what each one receives.
Source: `live-v2-hook-surface-probe.ts`. Raw dump: `live-v2-hook-surface.jsonl`.

## What fired (one tool-calling turn)

| hook | fired | payload |
|---|---|---|
| `session.hook("model.request")` | yes, 3 times | `{sessionID, agent, model:{id,providerID,variant}, kind, baseURL, headers}` |
| `session.hook("http.request")` | yes | `{sessionID, agent, model, kind, request}` — a real `Request`; url `https://api.deepseek.com/v1/chat/completions`, header keys include `authorization`, `x-opencode-session`, ... |
| `tool.hook("execute.before")` | yes | `{tool, sessionID, agent, messageID, id, input}` |
| `aisdk.hook("sdk")` | **no** | registered without error, never invoked |
| `aisdk.hook("language")` | **no** | registered without error, never invoked |

`model.request` kinds observed: `title`/`title` (auxiliary) and `primary`/`build` twice (the agent
loop, including the follow-up request that carries the tool result).

## Why this matters

1. **`chat.headers` is portable**: `model.request.headers` is a plain mutable object, so a plugin can
   set per-request headers exactly like the V1 `chat.headers` hook. The earlier port note that V2
   could not support it ("needs the user message id/role") was wrong: the V2 payload carries `kind`
   and `agent` instead, which is enough to distinguish the agent loop from title/summary requests.
   Auxiliary requests must be skipped, or header/param hooks would fire on title generation too.
2. **`model` carries `variant`** (`"default"` here) even though the published `SessionModelRequest`
   type does not declare it. The V1 `applyAgentVariant` half therefore has real input.
3. **`http.request` is not a path to the host API**: the URL is the model provider endpoint, so it
   cannot be used to enumerate sessions. It does expose the outgoing body/headers if a future hook
   needs to patch a request.
4. **`aisdk` hooks are an open question.** They registered cleanly but never fired for a provider
   configured as `aisdk:@ai-sdk/openai-compatible`. Either they fire only for other package kinds,
   or the SDK/language instance is built before plugin setup runs. Generation parameters
   (`temperature`/`topP`/`topK`/`maxOutputTokens`) have no field on `model.request`, so until this is
   resolved the V1 `chat.params` half has no confirmed V2 home. Next probe: register the hooks and
   force a fresh provider/model combination, and log at registration time to prove ordering.

## Not yet probed

`permission.hook("evaluate")`, `shell.hook("create.before")`, `session.hook("http.response")`,
`session.hook("retry")`, `session.hook("compaction")` output shape, and the `worktree`/`vcs`/
`integration` APIs. Each is listed in `docs/superpowers/plans/2026-09-24-omo-v2-full-parity.md`.
