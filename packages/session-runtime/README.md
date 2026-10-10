# Session Runtime

OC++ Session Execution (inbox, step, steer, interrupt, recovery) as a Specter application, written spec-first. OC++ core embeds it through `src/index.ts`, which exports only what core uses.

- **One composition runs Sessions.** `makeEmbeddedSessionRuntime` runs them over the Event Log, Slice stores and outbox stores the host provides, and `makeSessionEventStore` records the facts the host decides itself. OC++ keeps all of these in its database.
- **The runtime is OC++'s only inbox.** It decides admission, including a retried item ID (rejected with an exact reason, which the host reads as its first admission), the coalescing of repeated notices and a pending compaction absorbing another. It also decides delivery, cancellation and delivery changes.
- **The host supplies each step's I/O** through the `StepHost` port (`src/plugins/step-host.ts`). The step Plugin (`run-step.ts`) owns delivery, the step lifecycle, retries, recovery and finishing; the drive Plugin (`drive-execution.ts`) hands the host an external agent's execution whole.
- **Slices are the ones something invokes**: OC++ core, a Plugin or a Reaction.

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

Run `bun install` in OC++ again after rebuilding Specter: the links pick up the new `dist` by themselves, but a rebuilt `specter-spec` bin loses the executable bit that install sets.

A linked package resolves `effect` from the Specter checkout's `node_modules`, so a process would load two copies. `src/preload.ts` makes every process that loads this package run one Effect, and the `effect` entries in `paths` do the same for the type checker. Every package that loads this one, directly or through core, lists the preload in its `bunfig.toml`.

## Tests

- `scenarios.test.ts` runs every Slice's Scenarios.
- `session-integration.test.ts` runs the Slices and Plugins in process with a scripted `StepHost` (`test/fixture/scripted-step-host.ts`), which plays each Session's steps through the attempt recorder.
- `embedded.test.ts` and `session-recovery.test.ts` run `makeEmbeddedSessionRuntime`. Recovery keeps it in JSONL files (`test/fixture/jsonl-runtime.ts`), the simplest durable stores, and kills a child process mid-step.

## History

`docs/` holds the plan, the findings log and the last handoff, written while this runtime lived in the Specter repository as `apps/agent-runtime`.
