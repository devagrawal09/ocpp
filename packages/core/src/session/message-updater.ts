import { castDraft, produce, type WritableDraft } from "immer"
import { DateTime, Effect, Match, pipe, Schema } from "effect"
import { SessionEvent } from "./event.js"
import { SessionMessage } from "./message.js"

export interface Adapter {
  readonly getAgent: () => Effect.Effect<SessionMessage.AgentSelected["agent"] | undefined>
  readonly getModel: () => Effect.Effect<SessionMessage.ModelSelected["model"] | undefined>
  readonly getLocation: () => Effect.Effect<SessionMessage.LocationSwitched["previous"]>
  readonly getCurrentAssistant: () => Effect.Effect<SessionMessage.Assistant | undefined>
  readonly getAssistant: (messageID: SessionMessage.ID) => Effect.Effect<SessionMessage.Assistant | undefined>
  readonly getShell: (shellID: SessionMessage.Shell["shellID"]) => Effect.Effect<SessionMessage.Shell | undefined>
  readonly getCompaction: () => Effect.Effect<SessionMessage.Compaction | undefined>
  readonly getInvocation: (messageID: SessionMessage.ID) => Effect.Effect<SessionMessage.Invocation | undefined>
  readonly updateAssistant: (assistant: SessionMessage.Assistant) => Effect.Effect<void>
  readonly updateShell: (shell: SessionMessage.Shell) => Effect.Effect<void>
  readonly updateCompaction: (compaction: SessionMessage.Compaction) => Effect.Effect<void>
  readonly updateInvocation: (invocation: SessionMessage.Invocation) => Effect.Effect<void>
  readonly appendMessage: (message: SessionMessage.Info) => Effect.Effect<void>
}

type DraftAssistant = WritableDraft<SessionMessage.Assistant>

const projectTerminalSnapshot = (draft: DraftAssistant, event: SessionEvent.Step.Settled) => {
  if (event.data.snapshot || event.data.files)
    draft.snapshot = {
      ...draft.snapshot,
      end: event.data.snapshot,
      files: event.data.files ? Array.from(event.data.files) : undefined,
    }
}

export function update(adapter: Adapter, event: SessionEvent.DurableEvent) {
  type DraftTool = WritableDraft<SessionMessage.AssistantTool>
  const created = DateTime.makeUnsafe(event.created)

  const latestTool = (assistant: DraftAssistant, id: string) =>
    assistant.content.findLast((item): item is DraftTool => item.type === "tool" && item.id === id)

  const updateOwnedAssistant = (messageID: SessionMessage.ID, recipe: (draft: DraftAssistant) => void) =>
    Effect.gen(function* () {
      const assistant = yield* adapter.getAssistant(messageID)
      if (!assistant) return
      yield* adapter.updateAssistant(produce(assistant, recipe))
    })

  // An execution belongs to either a model tool call or an invocation message; only one of them matches.
  // Restart recovery settles an execution without a trace, so an empty trace keeps the projected one.
  const settleInvocation = (event: SessionEvent.CodeMode.Settled) =>
    Effect.gen(function* () {
      const invocation = yield* adapter.getInvocation(event.data.assistantMessageID)
      if (invocation?.executionID !== event.data.executionID) return
      yield* adapter.updateInvocation(
        produce(invocation, (draft) => {
          draft.status = event.data.outcome
          if (event.data.events.length > 0) draft.events = castDraft(event.data.events)
          if (event.data.outcome !== "completed") draft.error = event.data.error
          draft.time.completed = created
        }),
      )
    })

  const clearCurrentRetry = Effect.gen(function* () {
    const assistant = yield* adapter.getCurrentAssistant()
    if (!assistant?.retry) return
    yield* adapter.updateAssistant(
      produce(assistant, (draft) => {
        draft.retry = undefined
      }),
    )
  })

  const project = pipe(
    Match.type<SessionEvent.DurableEvent>(),
    Match.discriminatorsExhaustive("type")({
      "session-created": () => Effect.void,
      "session-viewed": () => Effect.void,
      "session-message-content-updated": (event) =>
        updateOwnedAssistant(event.data.messageID, (draft) => {
          draft.content = castDraft(
            Schema.decodeUnknownSync(Schema.Array(SessionMessage.AssistantContent))(event.data.content),
          )
        }),
      "session-usage-recorded": () => Effect.void,
      "session-tools-selected": () => Effect.void,
      "session-agent-selected": (event) =>
        Effect.gen(function* () {
          const previous = event.data.previous ?? (yield* adapter.getAgent())
          yield* adapter.appendMessage(
            SessionMessage.AgentSelected.make({
              id: SessionMessage.ID.fromEvent(event.id),
              type: "agent-switched",
              metadata: event.metadata,
              agent: event.data.agent,
              previous,
              time: { created },
            }),
          )
        }),
      "session-model-selected": (event) =>
        Effect.gen(function* () {
          const previous = event.data.previous ?? (yield* adapter.getModel())
          yield* adapter.appendMessage(
            SessionMessage.ModelSelected.make({
              id: SessionMessage.ID.fromEvent(event.id),
              type: "model-switched",
              metadata: event.metadata,
              model: event.data.model,
              previous,
              time: { created },
            }),
          )
        }),
      "session-moved": (event) =>
        Effect.gen(function* () {
          yield* adapter.appendMessage(
            SessionMessage.LocationSwitched.make({
              id: SessionMessage.ID.fromEvent(event.id),
              type: "location-switched",
              metadata: event.metadata,
              location: event.data.location,
              projectID: event.data.projectID,
              subpath: event.data.subpath,
              previous: yield* adapter.getLocation(),
              time: { created },
            }),
          )
        }),
      "session-renamed": () => Effect.void,
      "session-deleted": () => Effect.void,
      "session-forked": () => Effect.void,
      "session-inbox-delivered": () => Effect.void,
      "session-inbox-enqueued": () => Effect.void,
      "session-inbox-cancelled": () => Effect.void,
      "session-inbox-delivery-changed": () => Effect.void,
      "session-inbox-held": () => Effect.void,
      "session-execution-started": () => Effect.void,
      "session-execution-continued": () => Effect.void,
      "session-execution-settled": () => clearCurrentRetry,
      "session-instructions-updated": (event) => {
        if (event.data.text === undefined) return Effect.void
        return adapter.appendMessage(
          SessionMessage.System.make({
            id: SessionMessage.ID.fromEvent(event.id),
            type: "system",
            text: event.data.text,
            description: `Instructions updated: ${Object.keys(event.data.delta).join(", ")}`,
            metadata: event.metadata,
            time: { created },
          }),
        )
      },
      "session-synthetic": (event) => {
        return adapter.appendMessage(
          SessionMessage.Synthetic.make({
            text: event.data.text,
            description: event.data.description,
            metadata: event.data.metadata,
            id: SessionMessage.ID.fromEvent(event.id),
            type: "synthetic",
            time: { created },
          }),
        )
      },
      "session-displayed": (event) =>
        adapter.appendMessage(
          SessionMessage.Display.make({
            id: SessionMessage.ID.fromEvent(event.id),
            type: "display",
            metadata: event.metadata,
            title: event.data.title,
            blocks: event.data.blocks,
            time: { created },
          }),
        ),
      "session-skill-activated": (event) => {
        return adapter.appendMessage(
          SessionMessage.Skill.make({
            id: SessionMessage.ID.fromEvent(event.id),
            type: "skill",
            skill: event.data.id,
            name: event.data.name,
            text: event.data.text,
            metadata: event.metadata,
            time: { created },
          }),
        )
      },
      "session-shell-started": (event) => {
        return adapter.appendMessage(
          SessionMessage.Shell.make({
            id: SessionMessage.ID.fromEvent(event.id),
            type: "shell",
            metadata:
              event.data.shell.metadata.background === true ? { ...event.metadata, background: true } : event.metadata,
            shellID: event.data.shell.id,
            command: event.data.shell.command,
            status: event.data.shell.status,
            time: { created },
          }),
        )
      },
      "session-shell-settled": (event) =>
        Effect.gen(function* () {
          const currentShell = yield* adapter.getShell(event.data.shellID)
          if (currentShell) {
            yield* adapter.updateShell(
              produce(currentShell, (draft) => {
                draft.status = event.data.outcome
                draft.exit = event.data.exit
                draft.output = event.data.output
                draft.time.completed = created
              }),
            )
          }
        }),
      "session-step-started": (event) =>
        Effect.gen(function* () {
          const existing = yield* adapter.getAssistant(event.data.assistantMessageID)
          if (existing) {
            yield* adapter.updateAssistant(
              produce(existing, (draft) => {
                draft.agent = event.data.agent
                draft.model = castDraft(event.data.model)
                draft.retry = undefined
                draft.error = undefined
                draft.finish = undefined
                draft.rawFinish = undefined
                draft.providerState = undefined
                draft.time.streamed = undefined
                draft.time.completed = undefined
                if (event.data.snapshot) draft.snapshot = { ...draft.snapshot, start: event.data.snapshot }
              }),
            )
            return
          }
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                draft.retry = undefined
                draft.time.completed = created
              }),
            )
          }
          yield* adapter.appendMessage(
            SessionMessage.Assistant.make({
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              metadata: event.metadata,
              time: { created },
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
            }),
          )
        }),
      "session-step-streamed": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.time.streamed = created
        })
      },
      "session-step-settled": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const data = event.data
          if (data.outcome === "succeeded") {
            draft.time.completed = created
            draft.finish = data.finish
            draft.rawFinish = data.rawFinish
            draft.providerState = castDraft(data.providerState)
            draft.cost = data.cost
            draft.tokens = data.tokens
            projectTerminalSnapshot(draft, event)
            return
          }
          // A transparent retry runs the same step again: only the retry shows. A fresh one follows a step whose
          // output stands, so that step failed.
          if (!data.retry || data.retry.fresh) {
            draft.time.completed = created
            draft.finish = data.finish ?? "error"
            draft.rawFinish = data.rawFinish
            draft.providerState = castDraft(data.providerState)
            draft.error = castDraft(data.error)
            draft.retry = undefined
            if (data.cost !== undefined && data.tokens !== undefined) {
              draft.cost = data.cost
              draft.tokens = castDraft(data.tokens)
            }
            projectTerminalSnapshot(draft, event)
          }
          // The assistant shows the attempt about to run; the fact counts the retries so far.
          if (data.retry)
            draft.retry = {
              attempt: data.retry.attempt + 1,
              at: DateTime.makeUnsafe(data.retry.at),
              error: castDraft(data.error),
            }
        })
      },
      "session-block-recorded": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.content.push(
            castDraft(
              event.data.kind === "text"
                ? SessionMessage.AssistantText.make({ type: "text", text: event.data.text, state: event.data.state })
                : SessionMessage.AssistantReasoning.make({
                    type: "reasoning",
                    text: event.data.text,
                    state: event.data.state,
                    time: { created, completed: created },
                  }),
            ),
          )
        })
      },
      "session-tool-requested": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.content.push(
            castDraft(
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: event.data.id,
                name: event.data.name,
                executed: event.data.executed,
                providerState: event.data.state,
                time: { created, ran: created },
                state: SessionMessage.ToolStateRunning.make({
                  status: "running",
                  input: event.data.input,
                  metadata: {},
                }),
              }),
            ),
          )
        })
      },
      "session-tool-input-failed": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.content.push(
            castDraft(
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: event.data.id,
                name: event.data.name,
                executed: event.data.executed,
                providerResultState: event.data.resultState,
                time: { created, completed: created },
                state: SessionMessage.ToolStateError.make({
                  status: "error",
                  error: event.data.error,
                  input: {},
                  ...(event.data.content === undefined ? {} : { content: event.data.content }),
                  ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }),
                }),
              }),
            ),
          )
        })
      },
      "session-codemode-started": () => Effect.void,
      "session-invocation-started": (event) =>
        adapter.appendMessage(
          SessionMessage.Invocation.make({
            id: SessionMessage.ID.fromEvent(event.id),
            type: "invocation",
            metadata: event.metadata,
            trigger: event.data.trigger,
            code: SessionMessage.invocationCode(event.data.handler, event.data.input),
            executionID: event.data.executionID,
            status: "running",
            time: { created },
          }),
        ),
      "session-codemode-settled": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.id)
          if (!match || match.state.status === "streaming") return
          match.state.metadata = castDraft({
            ...match.state.metadata,
            executionID: event.data.executionID,
            executionStatus: event.data.outcome,
            events: event.data.events,
            ...(event.data.outcome === "completed" ? {} : { error: event.data.error }),
            ...(event.data.resumed === true ? { resumed: true } : {}),
          })
        }).pipe(Effect.andThen(settleInvocation(event)))
      },
      // Terminal tool events are self-contained. The only preserved state is a
      // durable Code Mode terminal that raced ahead of this outer tool success.
      "session-tool-settled": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const data = event.data
          const match = latestTool(draft, data.id)
          if (match?.state.status !== "running") return
          match.executed = data.executed || match.executed === true
          match.providerResultState = data.resultState
          match.time.completed = created
          if (data.outcome === "failed") {
            match.state = castDraft(
              SessionMessage.ToolStateError.make({
                status: "error",
                error: data.error,
                input: match.state.input,
                ...(data.content === undefined ? {} : { content: data.content }),
                ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
              }),
            )
            return
          }
          const terminal =
            match.state.metadata.executionStatus !== undefined && match.state.metadata.executionStatus !== "running"
              ? match.state.metadata
              : undefined
          match.state = castDraft(
            SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: match.state.input,
              content: data.content,
              ...(data.metadata === undefined && terminal === undefined
                ? {}
                : { metadata: { ...data.metadata, ...terminal } }),
            }),
          )
        })
      },
      "session-compaction-started": (event) =>
        adapter.appendMessage(
          SessionMessage.CompactionRunning.make({
            id: event.data.inputID ?? SessionMessage.ID.fromEvent(event.id),
            type: "compaction",
            status: "running",
            metadata: event.metadata,
            reason: event.data.reason,
            summary: "",
            recent: event.data.recent ?? "",
            time: { created },
          }),
        ),
      "session-compaction-ended": (event) =>
        Effect.gen(function* () {
          const current = yield* adapter.getCompaction()
          if (current?.status === "running") {
            yield* adapter.updateCompaction({
              ...current,
              status: "completed",
              reason: event.data.reason,
              summary: event.data.text,
              recent: event.data.recent,
            })
            return
          }
          yield* adapter.appendMessage(
            SessionMessage.Compaction.make({
              id: SessionMessage.ID.fromEvent(event.id),
              type: "compaction",
              status: "completed",
              metadata: event.metadata,
              reason: event.data.reason,
              summary: event.data.text,
              recent: event.data.recent,
              time: { created },
            }),
          )
        }),
      "session-compaction-failed": (event) =>
        Effect.gen(function* () {
          const current = yield* adapter.getCompaction()
          const failed = SessionMessage.CompactionFailed.make({
            id: current?.id ?? event.data.inputID ?? SessionMessage.ID.fromEvent(event.id),
            type: "compaction",
            status: "failed",
            metadata: current?.metadata ?? event.metadata,
            reason: event.data.reason,
            error: event.data.error,
            time: current?.time ?? { created },
          })
          if (current?.status === "running") return yield* adapter.updateCompaction(failed)
          yield* adapter.appendMessage(failed)
        }),
      "session-revert-staged": () => Effect.void,
      "session-revert-cleared": () => Effect.void,
      "session-revert-committed": () => Effect.void,
    }),
  )
  return project(event)
}

export * as SessionMessageUpdater from "./message-updater.js"
