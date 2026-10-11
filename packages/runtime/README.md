# Runtime

`@ocpp/runtime`: OC++'s Commands, Queries and Reactions as one Specter application, written spec-first. OC++ core embeds it through `src/index.ts`, which exports only what core uses. Features are grouped by domain under `src/features/<domain>/`: `session` (the Session lifecycle, what a Session records, and its execution: inbox, step, steer, interrupt, recovery), `project` (projects, their worktrees and a directory's resolution), `workspace`, `credential`, `kv` (the key-value store), `codemode` (Code Mode executions, their calls and notebook, its lifecycle in a Session, and a Session's commands and events), `job` (background job markers) and `testing` (test-only history). `src/features/facts.ts` holds one sample payload per fact, which `recordHistory`'s scenarios use.

- **One runtime.** `makeRuntime` composes every Slice in one config (`createRuntimeConfig` in `src/app.ts`) over the Event Log, Slice stores and outbox stores the host provides. OC++'s Bus makes it, dispatches every host Command through it (`bus.command`) and keeps all of it in OC++'s database: one log, one set of Slice snapshots, one outbox. A durable fact is recorded only by a Command.
- **Reactions start when the host starts them.** Commands and Queries work as soon as the runtime is made. The runtime is made with Specter's `reactions: "deferred"`: until `runtime.start(stepHost)`, no Reaction Plugin is initialized and no step job runs, a Command's `reactions` completes at once, and the runtime only remembers how far the log has gone. Starting provides the host's step I/O (`StepHost`) to the step and drive Plugins, which read it once, and catches the Reactions up with the log. OC++ needs this: its step I/O is built on services that record through the Bus, which makes the runtime.
- **Commands conflict only over what they decided on.** Every fact carries keys: its aggregate's ID and every other identity its payload names (a fork's parent, a Session's project, an inbox item, a credential's integration, a Code Mode execution; `src/events.ts`). Every Command declares the keys its decision reads (`.consistencyKeys`), so its append is stale only when a fact of a type it applies, carrying one of them, landed after it read its State: Session Commands by Session (an inbox admission also by its item, whose ID names one item across Sessions), Code Mode by Session or execution, projects and worktrees by project, workspaces, kv keys and background job markers by their own, credentials by credential, and their activation and removal by the credential's integration too, which their State knows (the one-active rule). `recordHistory` (tests only) reads no State and never conflicts. The Scenarios check each declaration.
- **Each Session's Reactions run on their own.** The step, wake and drive Reactions are keyed by Session (`.handleEachKey`): a commit requests a step, a wake or a drive for every Session it records for that needs one, each its own outboxed job, so a Session busy outside its steps (a long `begin`, `prepare` or compaction) holds back no other.
- **Commands decide the Session lifecycle.** `createSession` (an import's history included), `forkSession` (the child's creation and the fork in one commit), `moveSession` (a Session that cannot wait for its move), `deleteSession` (interrupting what runs and cancelling what waits, in the same commit), and `stageRevert`, `clearRevert` and `commitRevert` (which cancels the pending input the cut history leaves behind). Every Session Command refuses an unknown Session ("Session not found") and a deleted one ("Session deleted"), and the host maps those to its public errors.
- **Commands decide what a Session records.** Renames, agent, model and tool selections, views, displayed results, usage, message edits, skills and direct synthetic messages; instructions and instruction entries; user shells; compactions (the step host's `compact`, and an attempt's overflow recovery, record through the runtime's compaction recorder); an external agent's binding, vendor link and checkpoint, and its steps (`startAgentStep`, `finishAgentStep`); a directory's resolution to its project (`resolveWorktree`); and background job markers, each its own aggregate keyed by its notification. Each validates its aggregate from its own fold, and the host maps rejections to its errors or answers them as done.
- **Commands decide OC++'s other aggregates.** Projects (`resolveProject`, `editProject`) and their worktrees (`addWorktree`, `removeWorktree`, `refreshWorktrees`); workspaces (`createWorkspace`, `bindWorkspace`, `useWorkspace`, `destroyWorkspace`); credentials (`createCredential`, `activateCredential`, `updateCredential`, `removeCredential`), whose secret's key the host writes in the append transaction through the dispatch's commit hook; the key-value store (`storeValue`, `removeValue`); and Code Mode: its executions (`admitCodeModeExecution`, `startCodeModeExecution`, `resumeCodeModeExecution`, `settleCodeModeExecution`, `discardCodeModeExecution`), their calls (`scheduleCodeModeCall`, `progressCodeModeCall`, `settleCodeModeCall`), its lifecycle in a Session (`startCodeMode`, `settleCodeMode`, `startInvocation`) and a Session's commands and events (`defineCodeModeCommand`, `removeCodeModeCommand`, `defineCodeModeEvent`, `toggleCodeModeEvent`, `removeCodeModeEvent`, `planCodeModeEvent`, `fireCodeModeEvent`, `skipCodeModeEvent`). Each validates its aggregate from its own fold and refuses with an exact reason the host maps to its errors or answers as done.
- **The notebook is a fold.** Admission and settlement decide a Code Mode notebook's names and limits from the Session's executions. Where a message sits in a Session's history is the host's to know, so the facts that cut or copy a notebook name the executions they affect: `commitRevert` records `session-codemode-notebook-reverted` for the executions the host resolves from the cut (and every one admitted since the stage), settling those still running as failed, and `forkSession` records `session-codemode-notebook-copied` before the fork.
- **One vocabulary.** The runtime's facts are OC++'s durable wire events. `src/events.ts` defines every fact from `@ocpp/schema`'s durable event manifest under the kebab-case name the log stores, so nothing translates between the two. The host's projections apply each commit in the append transaction.
- **Tests set up history through `recordHistory`**, which records any fact as given. Only a runtime made with `history: true` registers it (OC++'s `Bus.configured({ history: true })`), so production cannot record a fact without its Command.
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
- `embedded.test.ts` and `session-recovery.test.ts` run `makeRuntime`, started with a scripted host. `embedded.test.ts` also runs one Session's steps while another is held in its `begin`, and records many Sessions at once without a stale append running out of retries. Recovery keeps it in JSONL files (`test/fixture/jsonl-runtime.ts`), the simplest durable stores, and kills a child process mid-step.

## History

`docs/` holds the plan, the findings log and the last handoff, written while this runtime lived in the Specter repository as `apps/agent-runtime`.
