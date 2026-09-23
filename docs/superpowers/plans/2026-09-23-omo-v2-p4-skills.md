# omo V2 P4-b — skill registration + the provider-domain assessment

Status: done and live-verified (2026-09-23); evidence
`.omo/evidence/20260923-v2-alignment/live-skill-audit.md` (8/8) and
`live-command-audit.log` (25/25)
Predecessors: MCP `3d86321`, commands `f7cf7d4`, and the two fixes `cdc822a` / `1492a33`.

## Goal

1. Register the skills omo owns into V2 through `ctx.skill.transform`, mapping SKILL.md/frontmatter
   onto `Skill.Info`.
2. Decide whether the client shim needs a `provider.list` surface to restore connected-provider
   filtering.

## Measured before designing

- The V2 host already discovers `.opencode/skills`, `.claude/skills` and `.agents/skills`, plus two
  built-ins of its own whose `path` is a virtual absolute path (`/builtin/opencode.md`). Only the
  builtin skills compiled into omo and the `@oh-my-opencode/shared-skills` bundle (which lives in
  `node_modules` and under no scanned directory) are invisible to it.
- `editor.get(id)` inside `ctx.skill.transform` does NOT see host-discovered skills, and adding a
  duplicate id does not override the host's copy. Virtual paths are accepted.
- The shared bundle resolves at runtime to `<pkg>/dist/skills`, which `build:shared-skills-assets`
  materializes next to the bundle.

## Design

- `skill-mapping.ts` (pure):
  - builtin -> `{id, name, description?, path: /omo-builtin/<name>.md, content: template}`. The
    virtual path is deliberate: the content is compiled in, and V1's `resolvedPath` for the bundled
    `dev-browser` skill points at a directory the published bundle does not ship.
  - discovered SKILL.md -> the real path plus the RAW body re-read from disk. V1's
    `definition.template` is unusable here: it is wrapped in `<skill-instruction>` and carries a
    `$ARGUMENTS` block that would leak into the model's context.
  - duplicate ids collapse to the first occurrence, reproducing V1's `mergeSkills` precedence
    (builtin beats shared: equal `SCOPE_PRIORITY`, builtin inserted first).
  - `autoinvoke` is never written (omo has no such concept; the host uses `optionalKey`).
- `register-skills.ts`: resolves active builtins (`resolveActiveBuiltinSkills` with the same options
  the command path uses), discovers the shared bundle and omo's own `skills` config, filters
  `disabled_skills` aliases, registers. Memoized by runtime key. The option builder is exported as
  `resolveConfiguredBuiltinSkills` so the command registrar cannot disagree with it.
- `register-commands.ts`: V1 also spread `builtinSkillsToCommandDefinitionRecord(...)` into the
  command list, so the same skills now register as slash commands (`/git-master`, ...), spread FIRST
  so a real command of the same name wins (`remove-ai-slops` and `init-deep` exist as both), with
  `disabled_commands` deleted from the skill set first.

## Provider-domain assessment (item 2): NOT implemented, on purpose

Measured V2 domains (`live-provider-domain.json`):

- `ctx.provider.list()` entries have keys `activation, id, integrationID, name, package, settings`.
  There is **no `connected` flag and no credential signal**; `activation` is
  `"auto" | "enabled" | "disabled"`, which describes enablement, not usable credentials.
- `ctx.model.list()` returns models with `providerID` and `id`.

omo's consumer already fails open without it: `fetchAvailableModels` treats an empty/unknown
connected set as "unknown" and falls back to `client.model.list()` (which the shim provides),
yielding the same `provider/model` set it would have built from `provider.list().data.all`. The other
call site (`connected-providers-cache`) is guarded and simply skips caching.

So the missing surface degrades nothing that matters, while implementing it would infer "connected"
from `activation` and could *narrow* the model set on a signal that does not mean "credentialed",
which is worse than not filtering. Recorded as an assessment, not a gap.

## Verification

- Unit: `skill-mapping.test.ts` (9), `register-skills.test.ts` (8), updated
  `register-commands.test.ts` (10, including the skill-command collision), 198 V2 tests green,
  `tsgo` clean.
- Live: `skill-qa.sh` (8 assertions) and `command-qa.sh` (25 assertions), both 0 failures.
- Full suite at the pre-existing baseline.
