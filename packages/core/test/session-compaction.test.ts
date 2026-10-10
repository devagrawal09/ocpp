import { expect, test } from "bun:test"
import { LLMClient, LLMEvent, LanguageModel, SystemPart, type LLMRequest } from "@ocpp/ai"
import { OpenAIChat } from "@ocpp/ai/protocols"
import { Database } from "@ocpp/core/database/database"
import { CodeMode } from "@ocpp/codemode"
import { CodeModeInstructions } from "@ocpp/core/codemode/instructions"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { Instructions } from "@ocpp/core/instructions/index"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { llmClient } from "@ocpp/core/effect/app-node-platform"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Bus } from "@ocpp/core/bus"
import { EventTable } from "@ocpp/core/event/sql"
import { Recorded } from "./lib/recorded"
import { SessionCompaction } from "@ocpp/core/session/compaction"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionHistory } from "@ocpp/core/session/history"
import { InstructionState } from "@ocpp/core/session/instruction-state"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionModelRequest } from "@ocpp/core/session/model-request"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionRunnerModel } from "@ocpp/core/session/runner/model"
import { SessionTable } from "@ocpp/core/session/sql"
import { SessionStore } from "@ocpp/core/session/store"
import { Session } from "@ocpp/core/session"
import { Project } from "@ocpp/core/project"
import { ProjectTable } from "@ocpp/core/project/sql"
import { App } from "@ocpp/core/app"
import { Agent } from "@ocpp/core/agent"
import { Model } from "@ocpp/core/model"
import { Provider } from "@ocpp/core/provider"
import { PluginHooks } from "@ocpp/core/plugin/hooks"
import { Location } from "@ocpp/core/location"
import { AbsolutePath } from "@ocpp/core/schema"
import { Money } from "@ocpp/schema/money"
import { Skill } from "@ocpp/schema/skill"
import { Shell } from "@ocpp/schema/shell"
import { DateTime, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

let requests: LLMRequest[] = []
const model = LanguageModel.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route,
})
const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: {
      read: Money.USDPerMillionTokens.make(0.1),
      write: Money.USDPerMillionTokens.make(0.5),
    },
  },
]
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
    return Stream.make(
      LLMEvent.textDelta({ id: "summary", text: "manual summary" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: { normalized: "stop" },
        usage: {
          inputTokens: 15,
          outputTokens: 6,
          nonCachedInputTokens: 10,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
          reasoningTokens: 2,
        },
      }),
      LLMEvent.finish({
        reason: { normalized: "stop" },
      }),
    )
  },
  generate: () => Effect.die("unused"),
})
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  cost,
  limit: { context: 200_000, output: 32_000 },
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      CodeModeStore.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      PluginHooks.node,
      SessionCompaction.node,
      SessionModelRequest.node,
    ]),
    [
      [Bus.node, Bus.configured()],
      [llmClient, client],
    ],
  ),
)

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction truncation does not split surrogate pairs", () => {
  const prefix = "a".repeat(1_999)

  expect(SessionCompaction.truncateToolOutput(`${prefix}😀suffix`)).toBe(`${prefix}😀\n[truncated]`)
  expect(SessionCompaction.truncateToolOutput("😀".repeat(2_000))).toBe("😀".repeat(2_000))
})

test("compaction prompt requires the checkpoint headings in order", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["Conversation history"] })
  expect(prompt.match(/^#{2,3} .+$/gm)).toEqual([
    "## Objective",
    "## Important Details",
    "## Work State",
    "### Completed",
    "### Active",
    "### Blocked",
    "## Next Move",
    "## Relevant Files",
  ])
  expect(prompt).toContain("one or two brief sentences")
  expect(prompt).toContain("constraints/preferences, decisions and why")
  expect(prompt).toContain("immediate concrete action")
  expect(prompt).toContain("next action if known")
  expect(prompt).toContain("Keep every section, even when empty.")
})

test("compaction points an existing summary to the following history", () => {
  const prompt = SessionCompaction.buildPrompt({ previousSummary: "Previous summary", context: ["Recent history"] })

  expect(prompt.split("\n", 1)[0]).toBe("Update the anchored summary below using the conversation history below.")
  expect(prompt).not.toContain("conversation history above")
})

it.effect("auto compaction reserves a buffer below the prompt ceiling", () =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    const session = Session.Info.make({
      id: Session.ID.make("ses_input_limit"),
      projectID: Project.ID.global,
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
    })
    const input = (tokens: number, limit: { context: number; input?: number; output: number }) => ({
      session,
      resolved: SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost: [],
        limit,
      }),
      messages: [
        Schema.decodeUnknownSync(SessionMessage.Assistant)({
          id: SessionMessage.ID.make("msg_assistant"),
          type: "assistant",
          agent: Agent.defaultID,
          model: { id: "test-model", providerID: "test-provider" },
          content: [],
          tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, completed: 0 },
        }),
      ],
    })

    const inputLimited = { context: 400_000, input: 272_000, output: 128_000 }
    expect(compaction.required(input(251_999, inputLimited))).toBe(false)
    expect(compaction.required(input(252_000, inputLimited))).toBe(true)

    const contextLimited = { context: 100_000, output: 10_000 }
    expect(compaction.required(input(79_999, contextLimited))).toBe(false)
    expect(compaction.required(input(80_000, contextLimited))).toBe(true)

    const outputLimited = { context: 100_000, output: 30_000 }
    expect(compaction.required(input(69_999, outputLimited))).toBe(false)
    expect(compaction.required(input(70_000, outputLimited))).toBe(true)
  }),
)

/** Seeds the global project plus one session row, returning the projected session. */
const insertSession = (id: Session.ID, overrides?: Partial<typeof SessionTable.$inferInsert>) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        ...overrides,
      })
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    return yield* store
      .get(id)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die(`session missing: ${id}`))))
  })

/** Admits, runs, and commits one notebook program through the real CodeMode host path, against current bindings. */
const runNotebook = Effect.fnUntraced(function* (
  sessionID: Session.ID,
  assistantMessageID: SessionMessage.ID,
  id: string,
  source: string,
) {
  const notebook = yield* CodeModeStore.Service
  const program = CodeMode.compile(source)
  const admission = yield* notebook.admit({ id, sessionID, assistantMessageID, toolCallID: `call_${id}`, program })
  if (!admission.ok) throw new Error(admission.message)
  const result = yield* CodeMode.execute({ code: program.source, program, bindings: admission.execution.bindings })
  if (!result.ok) throw new Error(result.error.message)
  return { settlement: yield* notebook.commit(admission.execution, result.declarations), value: result.value }
})

/** The same history read and renderer SessionContext.load uses for the request baseline. */
const notebookBaseline = Effect.fnUntraced(function* (sessionID: Session.ID) {
  const db = (yield* Database.Service).db
  const notebook = yield* CodeModeStore.Service
  const history = yield* SessionHistory.entriesForRunner(db, sessionID, Instructions.empty)
  return yield* CodeModeInstructions.notebook(notebook, sessionID, history.notebook)
})

it.effect("refreshes the notebook checkpoint only at successful compaction without accumulating it", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_notebook_compactions"))
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const compaction = yield* SessionCompaction.Service
    const modelRequests = yield* SessionModelRequest.Service
    const store = yield* SessionStore.Service
    const assistantMessageID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID: session.id,
      assistantMessageID,
      agent: Agent.defaultID,
      model: resolved.ref,
    })
    const save = (id: string, source: string) =>
      runNotebook(session.id, assistantMessageID, id, source).pipe(Effect.map((run) => run.settlement))
    const baseline = notebookBaseline(session.id)

    yield* save(
      "exe_before",
      "const durableData = { answer: 42 }; function durableHelper(x) { return durableData.answer + x }",
    )
    yield* InstructionState.prepare(db, bus, Instructions.empty, session.id)
    const initial = yield* baseline
    expect(initial).toContain("2 saved identifiers; 0 omitted")
    expect(initial).toContain("function durableHelper(x)")
    expect(yield* save("exe_after", "const laterValue = 'saved after the checkpoint'")).toEqual({
      status: "saved",
      saved: ["laterValue"],
    })
    // Between checkpoints the baseline is unchanged; the completion notification announces laterValue.
    expect(yield* baseline).toBe(initial)

    // Every epoch saves new values plus a helper calling the previous epoch's helper, so one saved
    // dependency chain spans all 25 checkpoints back to durableHelper.
    const refreshed = yield* Effect.forEach(
      Array.from({ length: 25 }, (_, index) => index),
      (index) =>
        Effect.gen(function* () {
          const before = yield* baseline
          const checkpoint = yield* InstructionState.notebook(db, session.id)
          expect(
            yield* save(
              `exe_epoch_${index}`,
              `const epochData${index} = { step: ${index + 1} }; ` +
                `function epochHelper${index}(x) { return ${index === 0 ? "durableHelper" : `epochHelper${index - 1}`}(x) + epochData${index}.step }`,
            ),
          ).toEqual({ status: "saved", saved: [`epochData${index}`, `epochHelper${index}`] })
          // Values saved since the last checkpoint stay out of the baseline until compaction succeeds.
          expect(yield* baseline).toBe(before)
          expect(yield* InstructionState.notebook(db, session.id)).toEqual(checkpoint)
          expect(before).not.toContain(`function epochHelper${index}(x)`)

          expect(
            yield* compaction.compactManual({
              session,
              resolveModel: () => Effect.succeed(resolved),
              prepare: modelRequests.prepare,
              messages: [
                ...(yield* store.context(session.id)),
                SessionMessage.User.make({
                  id: SessionMessage.ID.create(),
                  type: "user",
                  text: `Continue work ${index}`,
                  time: { created: DateTime.makeUnsafe(index) },
                }),
              ],
              inputID: SessionMessage.ID.make(`msg_notebook_compaction_${index}`),
            }),
          ).toEqual({ status: "completed" })
          const names = 3 + 2 * (index + 1)
          const checkpointed = yield* InstructionState.notebook(db, session.id)
          expect(checkpointed).toHaveLength(names)
          expect(checkpointed).toEqual(
            expect.arrayContaining([
              "durableData",
              "durableHelper",
              "laterValue",
              `epochData${index}`,
              `epochHelper${index}`,
            ]),
          )
          const after = yield* baseline
          expect(after).toContain(`${names} saved identifiers; 0 omitted`)
          expect(after).toContain(`function epochHelper${index}(x)`)
          expect(after).toContain(`epochData${index}`)
          expect(after.split("## Durable Notebook")).toHaveLength(2)
          return after
        }),
    )
    expect(requests).toHaveLength(25)
    expect(new Set(refreshed).size).toBe(25)
    const latest = refreshed[24]
    expect(latest).toContain("53 saved identifiers; 0 omitted")
    expect(latest).toContain("laterValue")
    expect(latest).toContain("function durableHelper(x)")
    expect(latest).toContain("function epochHelper0(x)")
    expect(latest).toContain("function epochHelper24(x)")
    // The inventory is rebuilt from notebook storage, never folded into the model-authored summary
    // or sent to the summarizer.
    const context = yield* store.context(session.id)
    expect(context).toMatchObject([{ type: "compaction", summary: "manual summary" }])
    expect(JSON.stringify(context)).not.toContain("Durable Notebook")
    expect(JSON.stringify(requests)).not.toContain("Durable Notebook")

    // After the final compaction the oldest and newest helpers still run, resolving the saved chain
    // from current bindings.
    expect(
      yield* runNotebook(
        session.id,
        assistantMessageID,
        "exe_final",
        "return [durableHelper(1), epochHelper0(1), epochHelper24(1), laterValue]",
      ),
    ).toEqual({ settlement: { status: "saved", saved: [] }, value: [43, 44, 368, "saved after the checkpoint"] })
  }),
)

it.effect("manual compaction summarizes short context instead of no-op", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const sessionID = Session.ID.make("ses_manual_compaction")
    const parentID = Session.ID.make("ses_manual_compaction_parent")
    const userMessage = {
      id: SessionMessage.ID.create(),
      type: "user" as const,
      text: "Manual compaction should include this short conversation.",
      skills: [
        {
          id: Skill.ID.make("effect"),
          name: Skill.Name.make("Effect"),
          text: "Use Effect services and generators.",
        },
      ],
      time: { created: DateTime.makeUnsafe(0) },
    }
    const session = yield* insertSession(sessionID, { parent_id: parentID })
    const modelRequests = yield* SessionModelRequest.Service

    const delta = yield* bus
      .subscribe(SessionEvent.Compaction.Delta)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    expect(
      yield* compaction.compactManual({
        session,
        resolveModel: () => Effect.succeed(resolved),
        prepare: modelRequests.prepare,
        messages: [
          userMessage,
          SessionMessage.Shell.make({
            id: SessionMessage.ID.create(),
            type: "shell",
            shellID: Shell.ID.make("sh_background"),
            status: "exited",
            command: "pwd",
            metadata: { background: true },
            output: { output: "display-only-output", cursor: 19, size: 19, truncated: false },
            time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
          }),
          SessionMessage.Synthetic.make({
            id: SessionMessage.ID.create(),
            type: "synthetic",
            text: "User shell pwd completed: /project",
            time: { created: DateTime.makeUnsafe(2) },
          }),
        ],
        inputID: SessionMessage.ID.make("msg_manual_compaction"),
      }),
    ).toEqual({ status: "completed" })
    expect(Array.from(yield* Fiber.join(delta)).map((event) => event.data.text)).toEqual(["manual summary"])

    expect(requests).toHaveLength(1)
    expect(requests[0]?.promptCacheKey).toBe(sessionID)
    expect(requests[0]?.http?.headers).toEqual({
      "x-session-affinity": sessionID,
      "X-Session-Id": sessionID,
      "x-parent-session-id": parentID,
      "User-Agent": App.useragent(App.make()),
      "x-ocpp-project": Project.ID.global,
      "x-ocpp-session": sessionID,
      "x-ocpp-client": "ocpp",
    })
    expect(requests[0]?.generation).toBeUndefined()
    expect(JSON.stringify(requests[0]?.messages)).toContain("Manual compaction should include this short conversation.")
    expect(JSON.stringify(requests[0]?.messages)).toContain("Use Effect services and generators.")
    expect(JSON.stringify(requests[0]?.messages)).toContain("User shell pwd completed: /project")
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("display-only-output")
    expect(yield* store.context(sessionID)).toMatchObject([
      { type: "compaction", reason: "manual", summary: "manual summary", recent: "" },
    ])
    expect(yield* store.get(sessionID)).toMatchObject({
      cost: 0.0000233,
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
    })
    expect(yield* Recorded.types(sessionID)).toEqual([
      SessionEvent.Compaction.Started.type,
      SessionEvent.UsageRecorded.type,
      SessionEvent.Compaction.Ended.type,
    ])
  }),
)

it.effect("manual compaction records model resolution failures without calling the model", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const compaction = yield* SessionCompaction.Service
    const store = yield* SessionStore.Service
    const sessionID = Session.ID.make("ses_manual_resolution_failure")
    const session = yield* insertSession(sessionID)
    const modelRequests = yield* SessionModelRequest.Service
    const inputID = SessionMessage.ID.make("msg_manual_resolution_failure")
    const assistantMessageID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.defaultID,
      model: resolved.ref,
    })
    yield* runNotebook(sessionID, assistantMessageID, "exe_checkpointed", "const checkpointedValue = 'in the baseline'")
    yield* InstructionState.prepare(db, bus, Instructions.empty, sessionID)
    const baseline = yield* notebookBaseline(sessionID)
    expect(baseline).toContain("1 saved identifiers; 0 omitted")
    expect(
      (yield* runNotebook(sessionID, assistantMessageID, "exe_pending", "const pendingValue = 'after the checkpoint'"))
        .settlement,
    ).toEqual({ status: "saved", saved: ["pendingValue"] })

    expect(
      yield* compaction.compactManual({
        session,
        resolveModel: () =>
          Effect.fail(
            new SessionRunnerModel.ModelUnavailableError({
              providerID: Provider.ID.make("test"),
              modelID: Model.ID.make("missing"),
            }),
          ),
        prepare: modelRequests.prepare,
        messages: [
          {
            id: SessionMessage.ID.create(),
            type: "user",
            text: "Summarize this conversation.",
            time: { created: DateTime.makeUnsafe(0) },
          },
        ],
        inputID,
      }),
    ).toEqual({
      status: "failed",
      error: { type: "provider.no-route", message: "Model unavailable: test/missing" },
    })
    expect(requests).toHaveLength(0)
    expect((yield* store.context(sessionID)).filter((message) => message.type === "compaction")).toMatchObject([
      {
        id: inputID,
        type: "compaction",
        status: "failed",
        reason: "manual",
        error: { type: "provider.no-route", message: "Model unavailable: test/missing" },
      },
    ])
    // A failed compaction keeps the established checkpoint; pendingValue waits for a successful one.
    expect(yield* InstructionState.notebook(db, sessionID)).toEqual(["checkpointedValue"])
    expect(yield* notebookBaseline(sessionID)).toBe(baseline)
  }),
)

it.effect("forked session compaction reuses the fork root prompt cache key", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const sessionID = Session.ID.make("ses_fork_compaction")
    const rootID = Session.ID.make("ses_fork_compaction_root")
    const session = yield* insertSession(sessionID, {
      fork_session_id: rootID,
      fork_boundary: { type: "before", messageID: SessionMessage.ID.create() },
    })
    const modelRequests = yield* SessionModelRequest.Service
    expect(
      yield* compaction.compactManual({
        session,
        resolveModel: () => Effect.succeed(resolved),
        prepare: modelRequests.prepare,
        messages: [
          {
            id: SessionMessage.ID.create(),
            type: "user",
            text: "Summarize the forked conversation.",
            time: { created: DateTime.makeUnsafe(0) },
          },
        ],
        inputID: SessionMessage.ID.make("msg_fork_compaction"),
      }),
    ).toEqual({ status: "completed" })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.promptCacheKey).toBe(rootID)
  }),
)

it.effect("keeps session context hooks away from compaction requests", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    // Context hooks shape the agent conversation; compaction is not part of it,
    // so it opts out and the transcript passes through unchanged.
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "context", (event) =>
      Effect.sync(() => {
        event.system.push(SystemPart.make("Injected conversation context"))
      }),
    )
    const session = yield* insertSession(Session.ID.make("ses_hook_compaction"))
    const modelRequests = yield* SessionModelRequest.Service
    expect(
      yield* compaction.compactManual({
        session,
        resolveModel: () => Effect.succeed(resolved),
        prepare: modelRequests.prepare,
        messages: [
          {
            id: SessionMessage.ID.create(),
            type: "user",
            text: "Summarize this conversation.",
            time: { created: DateTime.makeUnsafe(0) },
          },
        ],
        inputID: SessionMessage.ID.make("msg_hook_compaction"),
      }),
    ).toEqual({ status: "completed" })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.system).toEqual([])
  }),
)
