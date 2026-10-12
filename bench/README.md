# bench — paired-commit runner

`paired.ts` runs one task manifest under two OC++ commits with the same model and reports per-task deltas plus reliability events. It drives the existing headless `run --format json` and adds no agent loop.

## Run

```sh
bun bench/paired.ts --a <shaA> --b <shaB> --model claude/sonnet --tasks bench/tasks.json \
  --repeats 3 --out bench/out/<ts>/ [--only noedit,grounding] [--seed 1] [--pass-env CLAUDE_CODE_OAUTH_TOKEN]
cd bench && bun test ./paired.test.ts   # model-free smoke test
```

## Isolation

- Each arm gets a detached worktree (`out/wt-<sha>`) installed with `bun install --frozen-lockfile`. Your checkout is never touched.
- Every arm/repeat gets fresh HOME, XDG_*, TMPDIR, task git repo, config (`experimental.subagent_depth`, no MCP/plugins) and its own `serve` on a distinct loopback port.
- The child env holds only PATH plus the `--pass-env` names.
- Before admission the runner refuses an occupied port, matches the health PID and argv to the arm's worktree, and checks that the DB is under the isolated data dir.
- Blocks run serially; tasks interleave and AB/BA order is seeded.
- `meta.json` records SHAs, versions, deadlines, and hashes of the manifest, grader, runner and fixtures, plus dirty state.

## Archive and report

Each run keeps `envelope.json`, `stdout.jsonl`, `reply.txt`, `diff.patch`, `grade.json`, server logs, the isolated DB and `db.json` (bounded session_v2/session_message/codemode_execution rows, including descendants).

`report.json`/`report.md` give per task: A/B success, paired B−A with a bootstrap 95% CI, wall/token/cost deltas, timeout/reliability/setup counts, cache strata and raw pairs. Timeouts, server death, missing delivery and agent errors count as failures. Setup errors are excluded from pairs.

## Limitations

- Pass `CLAUDE_CODE_OAUTH_TOKEN` explicitly for `claude/*`. Its $ is an SDK estimate, and OpenAI $ is unknown.
- Provider caches can't be reset.
- The same model doesn't mean the same sampling, and agent clocks are real.
- Source builds report `version: "local"`.

## Blockers

None.
