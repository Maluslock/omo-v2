# Real-config default-path smoke after the V2 alignment work (2026-09-24)

## Why

By this point the V2 adapter had gained team tools, monitor tools, a session-activity tracker, a
rewritten event vocabulary and a repaired `chat.params` chain. Each was verified in isolation; this
smoke checks that an ordinary user turn with the **real omo config** still works end to end.

## Method

Copied the real `~/.config/opencode/opencode.json` into an isolated XDG sandbox, removed its
`plugins` array (it points at `oh-my-openagent@latest`, which 2.0.11 rejects), and loaded the locally
built bundle through the project plugin directory (`.opencode/plugins/omo-local.ts` ->
`/home/user/omo-v2/dist/index.js`) - the same wiring the user's host uses. One prompt with a real
provider: `Use omo_glob to list *.json in the current directory, then reply with exactly SMOKE_OK and
the number of matches.`

## Observed

Registration matches the real config exactly (no tools lost or duplicated):

```
[v2] agents registered {"agentCount":12,"defaultAgent":"Sisyphus - ultraworker"}
[v2] tools registered {"registered":13,"skipped":1,"skippedTools":["skill"]}
[v2] hooks registered {"registered":12}
[v2] mcps registered {"registered":5,"names":["websearch","context7","grep_app","lsp","codegraph"]}
[v2] commands registered {"registered":16,...}
[v2] skills registered {"registered":20,"builtin":10,"fromDisk":17,"disabled":0,"unreadable":0,...}
```

A full tool-call round completed with no hook errors in the log window:

```
TOOL omo_glob completed "Found 1 file(s)\n/home/user/omo-v2/.omo/tmp/real-smoke/proj/opencode.json"
final text: SMOKE_OK 1
```

`grep -aiE "\[error\]|hook execution failed|unhandled"` over the run's log window returned nothing.

## Note on one failed first attempt

The first attempt used the config's own default model (`new-api/deepseek-v4-pro`) with no `--model`
override and got `provider.internal: Internal server error (500)` from the gateway after three steps.
That is the remote endpoint rejecting the model id, not plugin behavior: registration was identical
and the plugin logged no error. Re-running with `--model deepseek/deepseek-v4-pro` succeeded. Worth
knowing because the real config's default model id is not in that provider's declared model list in
this config.

## Why this is enough

It exercises the real configuration's agent/hook/tool composition through a real provider with a real
tool call, which is the surface every one of the V2 changes touches. The detailed per-capability
proofs live in the sibling evidence files.

## What was omitted

No prompts from the user's real sessions, no API keys, and no session contents are recorded; the
sandbox config is a copy and the run's session lives in a throwaway SQLite database.
