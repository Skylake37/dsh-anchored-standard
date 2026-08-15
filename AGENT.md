# dsh-anchored-standard (downstream fork) — Agent Instructions

This repository is a fork of `xiaobright/dsh-anchored-standard` (upstream). Downstream
work lives only on `agent-dev`; `main` stays a clean upstream mirror so upstream
merges never conflict with local feature files.

## Branch layout

| Branch | Purpose |
|--------|---------|
| `main` | **Upstream mirror.** Fast-forwarded from `upstream/main` only. Never add downstream work here. Diff vs upstream must stay empty. |
| `agent-dev` | **Working branch for all agent sessions.** Superset of `main`: upstream content + downstream template work (`template/`, `tools/`, this file). Check it out and stay on it. |

## Branch usage

- Do not work directly on `main`.
- Create short-lived feature branches from `agent-dev` when a change needs review;
  merge them back into `agent-dev`. Routine agent work happens on `agent-dev`.
- Sync upstream:

```sh
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
git switch agent-dev
git merge main
git push origin agent-dev
```

The `main -> agent-dev` merge is idempotent when already current. If upstream
changes land while a feature branch is open, merge `main` into `agent-dev` first,
then rebase or merge the feature branch onto `agent-dev`.

## Upstream parameter sync

Upstream experimentally tunes anchor parameters (e.g. the tool list,
`bootstrapMaxTokens`, promotion events, suppressed context sources). After
merging upstream, follow the mapping table in `template/README.md` and update
`template/defaults.json` (and, only when the hook algorithm itself changed,
`template/hook/tool-bootstrap.mjs`). Then re-run the tests and regenerate any
installed presets.

## Done checks

1. `git log --oneline agent-dev..main` is empty (main fully merged into agent-dev).
2. `git log --oneline main..agent-dev` shows only downstream commits
   (`template/`, `tools/`, `AGENT.md`).
3. `npm test` is green.
