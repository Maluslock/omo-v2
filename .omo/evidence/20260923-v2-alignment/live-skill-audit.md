# QA evidence — V2 skill port (`ctx.skill.transform`) and the skill-command surface

Date: 2026-09-23
Host: opencode 2.0.11, private XDG-isolated `opencode serve` with the omo dist loaded from this repo
Plugin under test: `/home/user/omo-v2/dist/index.js`

## What was tested

- `src/v2/skill-mapping.ts` + `src/v2/register-skills.ts`: omo's builtin skills and the shared
  SKILL.md bundle are registered through `ctx.skill.transform`.
- `src/v2/register-commands.ts`: V1 also exposed every builtin skill as a slash command, so those
  commands are registered too, under the real builtin commands.
- The host's own discovery is left alone.

## Harness

- `skill-qa.sh` — project with `.opencode/skills/git-master/SKILL.md` (a deliberate collision) and
  `[opencode].disabled_skills = ["frontend"]`; dumps the host's whole skill list
  (`ctx.skill.list({})`) from inside a command execution, where the domain is fully populated.
- `command-qa.sh` — the command harness from the previous round, extended with the skill commands.

Both start a throwaway `opencode serve` with its own `XDG_{DATA,CONFIG,STATE,CACHE}_HOME`, and both
pin `browser_automation_engine.provider = "playwright"` so the builtin skill set is deterministic
(the isolated server also reads the real user layer, which selects a different browser skill).

## What was observed

Skill list (`live-skill-audit.log`, 8 assertions, 0 failures):

```
[v2] skills registered {"registered":19,"builtin":9,"fromDisk":17,"disabled":1,"unreadable":0,
  "names":["playwright","git-master","review-work","remove-ai-slops","init-deep","debugging",
           "security-research","security-review","visual-qa","programming","start-work",
           "coding-agent-sessions","ulw-research","ast-grep","data-scientist","refactor",
           "ulw-plan","lsp-setup","ultimate-browsing"]}
```

The host then lists 21 skills: omo's 19 plus its own `opencode` and `report`. Registered paths:

```
playwright            /omo-builtin/playwright.md          <- compiled builtin, virtual path
git-master            <proj>/.opencode/skills/git-master/SKILL.md   <- PROJECT COPY WINS
ast-grep              /home/user/omo-v2/dist/skills/ast-grep/SKILL.md
refactor              /home/user/omo-v2/dist/skills/refactor/SKILL.md
```

Commands (`live-command-audit.log`, 25 assertions, 0 failures):

```
[v2] commands registered {"registered":14,"names":["playwright","frontend","git-master",
  "review-work","remove-ai-slops","init-deep","debugging","security-research","security-review",
  "visual-qa","goal","refactor","start-work","stop-continuation"]}
```

`/git-master` was invoked through `POST /api/session/{id}/command` and delivered 28151 chars starting
with `<skill-instruction>` and containing the user argument, i.e. the skill template wrapper V1 used.

## Measurements that shaped the design (both live, before writing code)

1. **What the host already discovers.** A project with `.opencode/skills`, `.claude/skills` and
   `.agents/skills` entries, with NO omo loaded, listed all three plus the host's own
   `/builtin/opencode.md` and `/builtin/report.md`. So omo must not re-register user, project or
   Claude skills, and the host's own convention for a compiled skill is a virtual absolute path.
2. **Duplicate ids and virtual paths.** Registering a skill whose id the host had already discovered
   returned `get(id) === undefined` inside the transform and did not override the native entry; a
   virtual `/omo-builtin/...` path was accepted. So there is nothing to guard: the host's copy wins.

## Why it is enough

The assertions read the host's own skill list and the delivered message from the session store, not
omo's return values. The collision test proves the host's/project's skill is not clobbered, the
`disabled_skills` check proves config gating survives the port, and the "every disk path exists"
check rules out the stale-path failure mode (V1's `resolvedPath` for the bundled `dev-browser` skill
does point at a directory the published bundle does not ship, which is why builtins use a virtual
path instead).

## What was omitted / not proven

- No model round trip: prompting the model to load a skill fails on this host with the pre-existing
  gateway limitation (`OpenAI Chat user messages only support text and media content for now`).
  Registration and delivery are proven host-side.
- The `@path` reference resolution inside shared skills (V2 resolves it host-side) was not exercised.
- The official `bun run build` cannot run in this environment: `build:materialize-frontend` fails in
  `git submodule update --init` for `packages/shared-skills/upstreams/*`. The bundle was therefore
  produced with the documented `bun build ... --outdir dist` plus a `dist/skills` that was verified
  file-for-file identical to `packages/shared-skills/skills` (17 SKILL.md in both).
- Secret-bearing values: none captured in the artifacts.
