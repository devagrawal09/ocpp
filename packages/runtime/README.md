# Runtime

`@ocpp/runtime`: OC++'s Commands, Queries and Reactions as one Specter application, written spec-first. OC++ core embeds it through `src/index.ts`, which exports only what core uses. Features are grouped by domain under `src/features/<domain>/`: `session` today (the Session lifecycle and its execution: inbox, step, steer, interrupt, recovery); `project`, `credential`, `codemode` and the rest as their Commands arrive.

- **One runtime.** `makeRuntime` composes every Slice in one config (`createRuntimeConfig` in `src/app.ts`) over the Event Log, Slice stores and outbox stores the host provides. OC++'s Bus makes it and records every durable fact through it, and keeps all of it in OC++'s database: one log, one set of Slice snapshots, one outbox.
- **Reactions start when the host starts them.** Commands and Queries work as soon as the runtime is made. `runtime.start(stepHost)` binds the host's step I/O and catches the Reactions up with the log. Until then the Reaction scheduler only remembers how far the log has gone, and an outboxed job resolves the host before it does anything, so it waits. OC++ needs this: its step I/O is built on services that record through the Bus, which makes the runtime.
- **Commands decide the Session lifecycle.** `createSession` (an import's history included), `forkSession` (the child's creation and the fork in one commit), `moveSession` (a Session that cannot wait for its move), `deleteSession` (interrupting what runs and cancelling what waits, in the same commit), and `stageRevert`, `clearRevert` and `commitRevert` (which cancels the pending input the cut history leaves behind). Every Session Command refuses an unknown Session ("Session not found") and a deleted one ("Session deleted"), and the host maps those to its public errors.
- **One vocabulary.** The runtime's facts are OC++'s durable wire events. `src/events.ts` defines every fact from `@ocpp/schema`'s durable event manifest under the kebab-case name the log stores, so nothing translates between the two. The facts the host still decides go through `recordSessionFacts`, which stores them as given and refuses those a Command of their own decides; the host's projections still hold their invariants in the append transaction.
- **The runtime is OC++'s only inbox.** It decides admission, including a retried item ID (rejected with an exact reason, which the host reads as its first admission), the coalescing of repeated notices and a pending compaction absorbing another. It also decides delivery, cancellation and delivery changes.
- **The host supplies each step's I/O** through the `StepHost` port (`src/plugins/step-host.ts`). The step Plugin (`run-step.ts`) owns delivery, the step lifecycle, retries, recovery and finishing; the drive Plugin (`drive-execution.ts`) hands the host an external agent's execution whole.
- **Slices are the ones something invokes**: OC++ core, a Plugin or a Reaction.

Each Slice lives in `src/features/<domain>/<slice>/`: `spec.ts` holds its executable Scenarios, `spec.json` is generated from it, and `impl.ts` implements it. Regenerate after changing a `spec.ts`:

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
- `embedded.test.ts` and `session-recovery.test.ts` run `makeRuntime`, started with a scripted host. Recovery keeps it in JSONL files (`test/fixture/jsonl-runtime.ts`), the simplest durable stores, and kills a child process mid-step.

## History

`docs/` holds the plan, the findings log and the last handoff, written while this runtime lived in the Specter repository as `apps/agent-runtime`.
