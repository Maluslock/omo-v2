# V2 Hook Injection — findings (2026-09-23)

> P3 pre-work. Question: **how do omo's 12 V1 hook handlers map onto OpenCode V2's hook
> surfaces, and what does the V2 event envelope look like in practice?**
>
> Status: **V2 exposes 6 hook/transform surfaces; 6 of the 12 V1 handlers map onto `session.hook`
> / `tool.hook` / `permission.hook` / `shell.hook` / `event.subscribe` with a shape adapter; 2
> are registration-time transforms; 2 (`command.execute.before`, `experimental.compaction.autocontinue`)
> have no per-request V2 equivalent; `config`/`auth` belong to P4.**

## 1. V2 hook surfaces (from `@opencode/plugin@2.0.11`)

| Surface | Signature | Semantics |
|---|---|---|
| `ctx.event.subscribe()` | `() => AsyncIterable<OpenCodeEvent>` | long-lived stream, one subscription per `setup` |
| `ctx.session.hook(name, cb)` | `ModelHooks<SessionHooks>` | `prompt` / `context` / `compaction` / `generate` / `title` / `model.request` / `http.request` / `http.response` / `retry` / `experimental.ws.*` |
| `ctx.tool.hook("execute.before" \| "execute.after", cb)` | `Hooks<ToolHooks>` | per tool call; mutates `input` / `result` |
| `ctx.permission.hook("evaluate", cb)` | `Hooks<PermissionHooks>` | mutates `effect` / `message` |
| `ctx.shell.hook("create.before", cb)` | `Hooks<ShellHooks>` | mutates `env` / `cwd` / `timeout` / `shell` |
| `ctx.<domain>.transform(cb)` | `Transform<Editor>` | **registration-time**, sync, not per request (`tool`/`agent`/`command`/`model`/`provider`/`integration`/`reference`/`mcp`) |

Relevant event payload shapes (`@opencode/plugin/dist/promise/*.d.ts`):

```ts
// session.hook events (single mutable object, no (input, output) pair)
SessionPrompt      { sessionID, messageID, prompt: PromptInput.Prompt, metadata?, delivery }
SessionContext     { sessionID, agent, model, system: SystemPart[], messages: Message[], options, tools }
SessionCompaction  { ...SessionContext, result?: { summary, providerState?, metadata?, tokens? } }
SessionTitle       { ...SessionRequest, result?: string }
SessionModelRequest{ sessionID, agent, model, kind, baseURL?, headers }
SessionRetry       { sessionID, agent, model, error, attempt, decision: {retry:false}|{retry:true,delay} }

ToolHooks: "execute.before" { tool, sessionID, agent, messageID, id, input }
           "execute.after"  { tool, sessionID, agent, messageID, id, input,
                              status:"completed", result } | { status:"error", error }

PermissionHooks: "evaluate" { sessionID, agent?, action, resources[], metadata?, source?, effect, message? }
ShellHooks:      "create.before" { command, cwd, timeout, shell, env }
```

## 2. Live V2 event envelope (captured from `GET /api/event` on v2.0.11)

```json
{
  "id": "evt_0ccc1d298001Uc3NPHyFnxgSV5",
  "created": 1790141649560,
  "type": "session.created",
  "location": { "directory": "/home/user/omo-v2/.omo/probe5" },
  "data": {
    "sessionID": "ses_f333e2d92ffecADTnfjxs5x0aZ",
    "slug": "playful-rocket", "version": "2.0.11",
    "projectID": "7cbcacac...", "subpath": ".omo/probe5", "title": "evt"
  },
  "durable": { "aggregateID": "ses_...", "seq": 0, "version": 1 }
}
```

The envelope is **flat** (`type` + `data`), unlike V1's `{ type, properties }`. 22 events were
captured in one create+prompt+interrupt cycle, including `session.execution.started`,
`session.step.started`, `session.step.failed`, `session.inbox.enqueued/delivered`,
`session.execution.interrupted`.

Full V2 vocabulary extracted from `@opencode/schema@2.0.11` `event-manifest.d.ts`: ~130 types.
The lifecycle subset that matters here:

`session.created`, `session.deleted`, `session.idle`, `session.status`, `session.compacted`,
`session.compaction.{started,delta,ended,failed}`, `session.execution.{started,succeeded,failed,interrupted}`,
`session.step.{started,streamed,ended,failed}`, `session.retry.scheduled`, `session.agent.selected`,
`session.model.selected`, `session.renamed`, `session.moved`, `session.inbox.*`,
`session.text.{started,delta,ended}`, `session.reasoning.{started,delta,ended}`,
`session.tool.{called,input.started,input.delta,input.ended,progress,success,failed}`,
`session.usage.updated`, `permission.asked`, `permission.replied`, `file.edited`,
`filesystem.changed`, `server.connected`, `installation.update-available`, `location.shutdown`.

**Key structural difference:** V1 had coarse `message.updated` / `message.part.updated` events
carrying a whole message; V2 emits **granular per-part deltas** (`session.text.delta`,
`session.tool.progress`, …). Any V1 handler that relied on `message.updated.info.finish` needs a
synthesized view (see §5).

## 3. V1 hook handler inventory (12 handlers, from `plugin-interface.ts`)

All handlers are built by factories in `plugin/` and only depend on
`{ ctx, pluginConfig, managers, hooks, firstMessageVariantGate }`. They are therefore reusable
from a V2 wiring layer as-is; the work is the (input, output) ↔ V2 event bridge.

| V1 hook | input read | output written | hooks iterated | async |
|---|---|---|---|---|
| `chat.message` | `sessionID`, `agent`, `model{providerID,modelID}` | `message.model`, `parts` (push/splice) | 11 transform/session hooks + `startWork` + `goal.*` | yes |
| `chat.params` | `sessionID`, `agent`, `model{providerID,modelID\|id}`, `provider.id`, `message.variant` | `temperature`, `topP`, `maxOutputTokens`, `options.*` | none | yes |
| `chat.headers` | `sessionID`, `provider.id`, `message.{id,role}`, `model.api.npm` | `headers["x-initiator"]` | none | yes |
| `experimental.chat.messages.transform` | none | `messages.push(...)` | `contextInjectorMessagesTransform`, `teamModeStatusInjector`, `teamMailboxInjector`, `toolPairValidator`, `monitorStatusInjector`, `categorySkillReminder` | yes |
| `experimental.chat.system.transform` | `model.id` | `system` (mutate + push) | none | yes |
| `event` | `event.type`, `event.properties` | none | 27 event handlers + `sessionNotification` + 4 team handlers | yes |
| `tool.execute.before` | `tool`, `sessionID`, `callID` | `input.tool` (mutate), `args` (replaced) | 18 guard hooks + `sessionNotification` + `goal.setGoal` + `stopContinuationGuard` | yes |
| `tool.execute.after` | `tool`, `sessionID`, `callID\|callId\|call_id`, `args` | `title`, `output`, `metadata` | 21 after-hooks | yes |
| `tool.definition` | `toolID` | `description`, `parameters` | `todoDescriptionOverride` | yes |
| `command.execute.before` | `command`, `sessionID`, `arguments` | `parts` (push/splice) | `autoSlashCommand`, `startWork`, `goal.*` | yes |
| `experimental.session.compacting` | `sessionID` | `context.push(...)`, `prompt` | `compactionContextInjector.*`, `compactionTodoPreserver.capture`, `claudeCodeHooks[...]` | yes |
| `experimental.compaction.autocontinue` | `sessionID`, `agent` | `enabled` | `compactionContextInjector.restore`, `compactionTodoPreserver.restore` | yes |

Isolation: the interface layer has **no** `safeHook()`; each factory isolates internally
(`runEventHookSafely`, `runMessagesTransformHookSafely`, `runCompactionStep`) or lets errors
propagate. `safeCreateHook` only isolates hook *construction*.

## 4. V1 → V2 mapping

| V1 hook | V2 target | adapter work |
|---|---|---|
| `event` | `ctx.event.subscribe()` | map flat `{type,data}` → `{event:{type,properties}}`; rename/synthesize events (§5) |
| `tool.execute.before` | `tool.hook("execute.before")` | `{tool,sessionID,callID,args}` ↔ `{tool,sessionID,agent,messageID,id,input}`; write back `input` |
| `tool.execute.after` | `tool.hook("execute.after")` | map `result`/`error` → V1 `{title,output,metadata}` |
| `experimental.chat.messages.transform` | `session.hook("context")` | `output.messages` ↔ `event.messages` |
| `experimental.chat.system.transform` | `session.hook("context")` | `output.system` ↔ `event.system` |
| `chat.params` | `session.hook("model.request")` / `context.options` | V1 generation params ↔ V2 `options` (shape differs) |
| `chat.headers` | `session.hook("model.request")` | `output.headers` ↔ `event.headers` (direct) |
| `chat.message` | `session.hook("prompt")` | V1 `{message,parts}` ↔ V2 `prompt: PromptInput.Prompt`; **semantics differ** (V2 `prompt` fires once at durable admission) |
| `experimental.session.compacting` | `session.hook("compaction")` | V1 `context[]`/`prompt` ↔ V2 `result.summary` |
| `tool.definition` | `ctx.tool.transform` (registration-time) | already partially wired in P2 |
| `command.execute.before` | none | V2 only has registration-time `command.transform` |
| `experimental.compaction.autocontinue` | none | no post-compaction resume hook |
| `config` | per-domain transforms | P4 |
| `auth` | `integration.transform` | P4 |

## 5. Gaps and semantics risks

1. **`message.updated` synthesis.** V1 `event` handlers (`model-fallback`, `preemptiveCompaction`,
   `sessionNotification`, …) key off `message.updated` with `info.finish`/`info.role`/`info.time`.
   V2 emits per-part deltas. Two options: (a) synthesize `message.updated` from
   `session.text.ended` / `session.step.ended` / `session.usage.updated`; (b) call
   `ctx.session.context()` on `session.step.ended` and map via the P2.6 message mapper. (b) reuses
   tested code but costs a round trip; (a) is cheaper but must reconstruct `finish`.
2. **`session.error` → ?** V2 has `session.execution.failed` and `session.step.failed`; V1
   `session.error` carried a structured `error`. Need to pick a source and map the error shape.
3. **`session.status`** exists in both, but the V1 payload's `{type, attempt, message, next}` may
   differ from V2's; must be verified against a real retry/status event.
4. **`prompt` vs `chat.message` semantics.** V1 `chat.message` ran per user message *before*
   durable admission with a mutable `parts` array; V2 `prompt` fires once per admitted prompt with
   `text`/`files`/`agents`/`skills`. Transformations omo applies (keyword detection, model
   override, variant) must be re-expressed against the V2 prompt object.
5. **`command.execute.before`** (slash-command interception, `/goal`, `/start-work`) has no
   per-invocation V2 hook. Candidate: `command.transform` registration + `session.hook("prompt")`
   inspection, or move the logic into the tools/hooks that already handle it.
6. **`experimental.compaction.autocontinue`** (auto-resume after compaction) has no V2 signal.
   Candidate: observe `session.compacted` via `event.subscribe` and dispatch a prompt through the
   existing gated path.
7. **Registration lifecycle.** `ctx.<domain>.hook(...)` returns a `Registration` with `dispose`.
   `setup` may run more than once; registrations must be tracked and disposed like managers
   (`register-tools.ts` already does this for managers).

## 6. Assembly feasibility

`createHooks({ ctx, pluginConfig, modelCacheState, backgroundManager, modelFallbackControllerAccessor,
monitorManager, isHookEnabled, safeHookEnabled, mergedSkills, availableSkills })` is constructible in
V2: `createManagers` + `createTools` already run there, and `createTools` returns `mergedSkills`
/ `availableSkills`. `isHookEnabled` / `safeHookEnabled` come from the config pipeline. So P3 can
reuse all 12 handler factories unchanged and only add the bridge layer.

## 7. Caveats

- The event envelope/vocabulary above is **live-captured**; the rest is type-derived.
- No V2 retry/status/error event was observed with a live model (no provider in the isolated
  config), so §5.2/§5.3 mappings are unverified.
- **Plugin-injection QA remains blocked in this sandbox** (see
  `.omo/evidence/20260923-v2-client-shim/plugin-discovery-blocker.md`), so hook firing cannot be
  proven end-to-end here; unit tests + shape pinning are the available evidence.

---

## 8. Task 5 correction: omo has no V1 `shell.env` / `permission.ask` hooks to port

Grepping the V1 adapter shows omo never registered either hook:

- **`shell.env`**: no handler exists anywhere under `packages/omo-opencode/src`.
- **`permission.ask`**: the string appears only as an *event name* consumed by
  `hooks/session-notification.ts:75`; there is no `permission.ask` hook handler.
- Permissions were expressed two other ways, both already ported: as **agent tool restrictions**
  (mapped to V2 agent permissions in P1, `v2/agent-mapping.ts`) and as **tool-execute guards**
  (mapped in P3 task 3, e.g. `bashFileReadGuard`, `writeExistingFileGuard`, `prometheusMdOnly`).
- The only runtime permission asks are `ctx.ask(...)` inside two tools
  (`tools/skill/tools.ts:153`, `tools/monitor/monitor-start.ts:103`), and the V2 ToolContext has
  no `ask` (P2 fail-closed).

Therefore V2's `permission.hook("evaluate")` and `shell.hook("create.before")` are **new
capabilities, not ports**. Wiring them would mean inventing policy omo never had; they are left
out of P3 rather than implemented speculatively.

---

## 9. `model.request` is only partially portable

`SessionModelRequest` is `{sessionID, agent, model, kind, baseURL?, headers}` — it carries **no
message context and no generation options**. That splits the two V1 hooks:

- **`chat.params`** wrote generation settings. Those are bridged onto `session.hook("context")`
  instead, because `SessionContext` does carry `options`; `temperature` / `topP` / `topK` /
  `maxOutputTokens` are lifted onto `options` alongside `output.options`.
  Its `input.message.variant` half has no V2 context equivalent — omo's `applyAgentVariant` reads
  it — so the registration logs that gap once instead of dropping it silently. (In V2 the
  variant dimension is expressed at **agent registration**, which P1 already maps.)
- **`chat.headers`** is deliberately **not** bridged: `isOmoInternalMessage` requires
  `message.role === "user"` **and** `message.id`
  (`plugin/chat-headers.ts:108-118`), and `SessionModelRequest` provides neither, so the handler
  would always return without writing `x-initiator`. Registering it would be a silent no-op.
