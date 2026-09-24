# `session_read` unlocked on V2 (evidence)

Date: 2026-09-24
Host: opencode 2.0.11, real service, omo loaded from `~/.config/opencode/plugins/omo-local.ts`

## Why it was blocked, and why it no longer needs to be

`CLIENT_DEPENDENT_TOOLS` excluded all four `session_*` tools because the session storage layer is
built around the V1 client. Checking the actual call graph splits them:

| tool | needs | V2 |
|---|---|---|
| `session_read` | `client.session.messages()` for one known id | **available**: the shim serves it from `ctx.session.context` |
| `session_list` | `client.session.list()` | **unavailable**: `ctx.session` is a `Pick` of `SessionApi`; its runtime key set is `hook, create, get, switchAgent, switchModel, prompt, generate, command, synthetic, interrupt, update, move, wait, context` |
| `session_search` | all sessions (list) | unavailable, same reason |
| `session_info` | `getSessionInfo` -> session list | unavailable, same reason |

`session_read` also starts with `sessionExists()`, which is implemented as
`client.session.messages(id).length > 0`, i.e. the same message read. So the unlock is a gating
change, not new plumbing.

## Change

- `session_read` moved from `CLIENT_DEPENDENT_TOOLS` to `SHIM_UNLOCKED_TOOLS`;
- the exclusion comment now names the three tools that genuinely cannot work and why;
- `register-tools.test.ts` mock registry gained `session_read` and pins it as registered.

## Observed

Registration on a fresh location (real service, user config):

```
[v2] agents registered {"agentCount":12,"defaultAgent":"Sisyphus - ultraworker"}
[v2] tools registered {"registered":10,"skipped":4,
                       "skippedTools":["session_list","session_search","session_info","skill"]}
```

`session_read` invoked on a real session id through the model:

```json
{
  "tool": "omo_session_read",
  "status": "completed",
  "input": { "session_id": "ses_f2e968df1ffepW47sam0W7QFaW", "from_end": true },
  "outputLength": 17285,
  "outputHead": "\n[user] 2026-09-24T03:15:47.495Z\n\"Use the glob tool with pattern *.md...\"\n[assistant] ...\n[tool result] ..."
}
```

Raw artifact: `live-session-read.json`. The transcript includes the user message, the tool result and
the host's system messages, so the shim's `ctx.session.context` -> V1 `session.messages` mapping
carries real content rather than an empty shell.

Registration is also idempotent per location: a second run in the same directory logged no new
registration block.

## What was omitted / caveats

- `session_start`-style listing, search and info remain blocked; they cannot be faked without a
  session enumeration API, and the file-layout fallback reads 0 sessions (measured earlier).
- The `skill` tool stays excluded, and that is now a deliberate non-issue for capability: the V2 host
  ships its own `skill` tool and it loads omo-registered skills. Verified in the provider sandbox:
  `→ Skill "git-master"` followed by `SKILL_OK`, with omo's 20 skills registered.
- Unit tests also write to `/tmp/oh-my-opencode.log`. A registration line with tiny counts
  (`registered:1`, `ctx.mcp.transform unavailable`) comes from `bun test` mock contexts, not from a
  host run; log-based measurement must use a line-delta window and must not run concurrently with the
  test suite.
