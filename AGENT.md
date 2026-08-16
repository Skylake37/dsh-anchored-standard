# dsh-anchored-standard (downstream fork) — Agent Instructions

This repository is a fork of `xiaobright/dsh-anchored-standard` (upstream). Downstream
work lives on `agent-dev`; `main` stays an upstream mirror plus the single sync
workflow that maintains it, so upstream merges never conflict with local feature files.

## Branch layout

| Branch | Purpose |
|--------|---------|
| `main` | **Upstream mirror + sync infra.** Rebased onto `upstream/main` by the sync workflow, then force-pushed. The only local file allowed here is `.github/workflows/sync-upstream.yml`; never add anything else. |
| `agent-dev` | **Working branch for all agent sessions.** Superset of `main`: upstream content + downstream template work (`template/`, `tools/`, `AGENT.md`, `CLAUDE.md`). Check it out and stay on it. |

## Branch usage

- Do not work directly on `main`.
- Create short-lived feature branches from `agent-dev` when a change needs review;
  merge them back into `agent-dev`. Routine agent work happens on `agent-dev`.
- Manual sync upstream:

```sh
git fetch upstream
git switch main
git pull --ff-only origin main
git rebase upstream/main
git push --force-with-lease origin main
git switch agent-dev
git merge main
git push origin agent-dev
```

The `main -> agent-dev` merge is idempotent when already current. If upstream
changes land while a feature branch is open, merge `main` into `agent-dev` first,
then rebase or merge the feature branch onto `agent-dev`.

## Automated upstream sync

`.github/workflows/sync-upstream.yml` (present on both `main` and `agent-dev`,
same content) runs every 15 minutes while upstream is in its fast-moving
period, plus on manual `workflow_dispatch`:

1. fetch `upstream/main`;
2. rebase `main` onto `upstream/main` (with an `origin/main` race-guard rebase),
   then push `origin main` with `--force-with-lease`;
3. merge `main` into `agent-dev` and push `origin agent-dev`.

On a failed sync step it opens (or comments on) a GitHub issue labeled
`conflict` with the exact local resolution commands. Conflicts are resolved by
an agent, never auto-resolved by the workflow. After resolving, close the issue
and re-run the workflow to confirm green.

## Upstream parameter sync

Upstream experimentally tunes anchor parameters (e.g. the tool list,
`bootstrapMaxTokens`, promotion events, suppressed context sources). After
merging upstream, follow the mapping table in `template/README.md` and update
`template/defaults.json` (and, only when the hook algorithm itself changed,
`template/hook/tool-bootstrap.mjs`). Then re-run the tests and regenerate any
installed presets.

## Done checks

1. `git log --oneline agent-dev..main` is empty (main fully merged into agent-dev).
2. `git fetch upstream` then `git diff --name-only upstream/main..main` shows only
   `.github/workflows/sync-upstream.yml` (main is the pure mirror plus sync infra).
3. `git log --oneline main..agent-dev` shows only downstream commits
   (`template/`, `tools/`, `AGENT.md`, `CLAUDE.md`).
4. `npm test` and `npm run check` are green.
