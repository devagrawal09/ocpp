# Session Runtime

OC++ Session Execution (inbox, step, steer, interrupt, recovery) as a Specter application, written spec-first. OC++ core embeds it through `src/index.ts`.

Each Slice lives in `src/features/session/<slice>/`: `spec.ts` holds its executable Scenarios, `spec.json` is generated from it, and `impl.ts` implements it. Regenerate after changing a `spec.ts`:

```sh
bun run spec:build   # specter-spec export src/features
bun run test         # regenerates, then runs the Scenarios and the runtime tests
bun run typecheck
```

## Specter packages

The `@specter-ts/*` packages are consumed through `bun link` from a Specter checkout, as if published. Build and register them once per machine:

```sh
# in the Specter checkout
pnpm install && pnpm build:publishable
for package in core memory reaction-outbox jsonl spec; do (cd packages/$package && bun link); done
# then in OC++
bun install
```

A linked package resolves `effect` from the Specter checkout's `node_modules`, so a process would load two copies. `src/preload.ts` makes every process that loads this package run one Effect, and the `effect` entries in `paths` do the same for the type checker. Every package that loads this one, directly or through core, lists the preload in its `bunfig.toml`.

## History

`docs/` holds the plan, the findings log and the last handoff, written while this runtime lived in the Specter repository as `apps/agent-runtime`.
