# bench — paired-commit runner

`paired.ts` runs one manifest under two OC++ commits with one model through the existing headless `run --format json`.

## Run

```sh
bun bench/paired.ts --a <rev> --b <rev> --model claude/sonnet --repeats 3 --out bench/out/<new-dir>/ \
  [--only noedit,grounding] [--seed 1] [--pass-env CLAUDE_CODE_OAUTH_TOKEN] [--resume]
cd bench && bun test ./paired.test.ts
```

## Enforced

- `--out` must be new or empty. `--resume` requires identical frozen inputs (SHAs, model, seed, manifest/grader/runner/fixture hashes), keeps completed runs and moves partial ones to `attempts/`.
- Task IDs and fixtures are single path components without symlinks.
- Arms run in a fresh detached worktree, installed with `--frozen-lockfile`. Worktrees must be clean, and the tree and lockfile hashes are archived.
- Each arm/repeat gets fresh HOME, XDG_* and TMPDIR, a task repo and a `serve` on its own port, under a `/tmp` work root with no config ancestors.
- Preflight refuses live ports, PID/argv mismatches, ancestor config, and any config other than the generated document. MCP servers, plugins and references must be empty.
- Credentials go only to the server via the `--pass-env` allowlist. The client, git, grader and session shell get credential-free environments.
- Every arm writes `envelope.json`, even on failure. Owned processes and descendants are killed before the next arm.

## Report

Success requires a valid run, task pass and conduct pass. Hidden behavioural suites and pre-run hashes back the grader.

Each task row has pairs, bootstrap CIs (n≥2 only), wall/token/cost deltas over the whole session tree, and to/reliability/invalid/setup counts. Cost is labelled `sdk_estimate` or `unknown`, and unknown cost gives no delta.

## Limitations

- HOME isolation is not an OS sandbox.
- Provider caches can't be reset; only first-request cache reads are reported.
- The same model doesn't mean the same sampling.
- `e2e-1`/`e2e-2` are single-repeat, read-only smoke runs.

## Blockers

None.
