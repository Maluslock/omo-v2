# P6-C1 build path — reproducible local build (2026-09-24)

## The blocker, diagnosed

`bun run build` failed at `build:materialize-frontend`
(`node packages/omo-codex/plugin/scripts/materialize-shared-upstreams.mjs --strict`), which runs

```
git submodule update --init --recursive \
  packages/shared-skills/upstreams/{open-design,taste-skill,ui-ux-pro-max,designpowers}
```

Running that by hand gives

```
error: pathspec 'packages/shared-skills/upstreams/open-design' did not match any file(s) known to git
```

so this is **repository state, not network**: `.gitmodules` declares the four submodules but the git
index has no gitlink entries for them (the directories exist and are empty).

## The escape hatch is already in the repo

`materialize-shared-upstreams.mjs` supports both a skip and a non-strict mode:

```
OMO_SKIP_MATERIALIZE=1         -> "[materialize] skipped (OMO_SKIP_MATERIALIZE=1)"
OMO_MATERIALIZE_STRICT=1 / --strict  -> submodule failure is fatal (the default used by the build)
```

## The recipe that works

```bash
OMO_SKIP_MATERIALIZE=1 bun run build      # exit 0, "build: all steps completed"
```

It produces `dist/index.js` (5.8 MB) and materializes `dist/skills` (17 skills), which is exactly the
artifact set the V2 runtime reads (`sharedSkillsRootPath()` resolves next to the bundle). Skipping
materialization only leaves the frontend skill's upstream references un-refreshed; every other step,
including the node-require shim that my ad-hoc `bun build` was missing, runs normally.

## Verified

Real service, fresh directory, plugin loaded through
`~/.config/opencode/plugins/omo-local.ts`:

```
> Sisyphus - ultraworker · deepseek-v4-pro
✱ Glob "*.md" 1 match
> Sisyphus - ultraworker · deepseek-v4-pro
OFFICIAL_BUILD_OK

[v2] agents registered {"agentCount":12,"defaultAgent":"Sisyphus - ultraworker"}
[v2] tools registered  {"registered":13,"skipped":1,"skippedTools":["skill"]}
[v2] skills registered {"registered":20,"builtin":10,"fromDisk":17,"disabled":0,"unreadable":0}
[v2] session index ready {"entries":0,"directory":".../postbuild-check"}
```

Full suite: 12892 pass / 13 fail, i.e. the 15-test baseline **minus** the two
`dist bundle Bun globals` cases, which only pass with the official build. Log:
`full-test-chatheaders.log`.

## Not done on purpose

Publishing is out of scope (the user asked not to publish): this is the local build/install path. A
real release still goes through `.github/workflows/publish.yml`, which builds in CI where the
submodules are expected to be initialized.
