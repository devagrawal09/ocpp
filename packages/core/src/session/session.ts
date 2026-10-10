export * as Session from "./session.js"

import { DateTime, Effect, Fiber, Layer, Schema, Scope } from "effect"
import type { Agent } from "@ocpp/schema/agent"
import type { Model } from "@ocpp/schema/model"
import type { FileAttachment } from "@ocpp/schema/prompt"
import { Event } from "@ocpp/schema/event"
import { Bus } from "../bus.js"
import { Location } from "../location.js"
import { PluginSupervisor } from "../plugin/supervisor-service.js"
import { Shell } from "../shell.js"
import { ShellResult } from "../shell/result.js"
import { Reference } from "../reference.js"
import {
  BusyError,
  CompactionConflictError,
  DisplayConflictError,
  DisplayInvalidError,
  InboxConflictError,
  MessageIncompleteError,
  MessageNotAssistantError,
  MessageNotFoundError,
  MessageToolIncompleteError,
  NotFoundError,
  PromptConflictError,
  SyntheticConflictError,
} from "./error.js"
import { SessionEvent } from "./event.js"
import { SessionExecution } from "./execution.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionPrompt } from "./prompt.js"
import { SessionRevert } from "./revert.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

export type Services =
  | PluginSupervisor.Service
  | Reference.Service
  | SessionPrompt.Service
  | SessionRevert.Service
  | Shell.Service

type PromptRequest = SessionPrompt.Input & {
  id?: SessionMessage.ID
  resume?: boolean
}

/**
 * Build once in the host Scope: `const sessions = yield* Session.make(servicesFor)`.
 * Use `sessions.forSession(id)` for handles that share host services and reload current state.
 */
export const make = Effect.fn("Session.make")(function* (servicesFor: (ref: Location.Ref) => Layer.Layer<Services>) {
  const bus = yield* Bus.Service
  const store = yield* SessionStore.Service
  const execution = yield* SessionExecution.Service
  const admission = yield* SessionInbox.Service
  const scope = yield* Scope.Scope

  const get = Effect.fn("Session.get")(function* (sessionID: SessionSchema.ID) {
    const session = yield* store.get(sessionID)
    if (!session) return yield* new NotFoundError({ sessionID })
    return session
  })
  const message = Effect.fn("Session.message")(function* (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) {
    const stored = yield* store.message(messageID)
    return stored?.sessionID === sessionID ? stored.message : undefined
  })
  const updateMessage = Effect.fn("Session.updateMessage")(function* (
    sessionID: SessionSchema.ID,
    input: { readonly messageID: SessionMessage.ID; readonly content: readonly SessionMessage.AssistantContent[] },
  ) {
    const ref = { sessionID, messageID: input.messageID }
    yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    const current = yield* message(sessionID, input.messageID)
    if (!current) return yield* new MessageNotFoundError(ref)
    if (current.type !== "assistant") return yield* new MessageNotAssistantError(ref)
    if (!current.time.completed) return yield* new MessageIncompleteError(ref)
    if (input.content.some(isUnfinishedTool)) return yield* new MessageToolIncompleteError(ref)
    yield* bus.publish(SessionEvent.MessageContentUpdated, {
      ...ref,
      content: Schema.encodeSync(Schema.Array(SessionMessage.AssistantContent))(input.content),
    })
    const updated = yield* message(sessionID, input.messageID)
    if (updated?.type !== "assistant") return yield* new MessageNotFoundError(ref)
    return updated
  })
  const view = Effect.fn("Session.view")(function* (sessionID: SessionSchema.ID, input: { idle: number }) {
    const session = yield* get(sessionID)
    if (
      session.time.idle === undefined ||
      input.idle > DateTime.toEpochMillis(session.time.idle) ||
      (session.time.viewed !== undefined && DateTime.toEpochMillis(session.time.viewed) >= input.idle)
    )
      return
    yield* bus.publish(SessionEvent.Viewed, { sessionID, idle: input.idle })
  })
  const rename = Effect.fn("Session.rename")(function* (sessionID: SessionSchema.ID, input: { title: string }) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.Renamed, { sessionID, title: input.title })
  })
  const switchAgent = Effect.fn("Session.switchAgent")(function* (
    sessionID: SessionSchema.ID,
    input: { agent: Agent.ID },
  ) {
    const session = yield* get(sessionID)
    yield* bus.publish(SessionEvent.AgentSelected, { sessionID, agent: input.agent, previous: session.agent })
  })
  const selectTools = Effect.fn("Session.selectTools")(function* (
    sessionID: SessionSchema.ID,
    input: { tools: ReadonlyArray<string> },
  ) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.ToolsSelected, { sessionID, tools: input.tools })
  })
  const switchModel = Effect.fn("Session.switchModel")(function* (
    sessionID: SessionSchema.ID,
    input: { model: Model.Ref },
  ) {
    const session = yield* get(sessionID)
    if (
      session.model?.providerID === input.model.providerID &&
      session.model.id === input.model.id &&
      (session.model.variant ?? "default") === (input.model.variant ?? "default")
    )
      return
    yield* bus.publish(SessionEvent.ModelSelected, { sessionID, model: input.model, previous: session.model })
  })
  const mutatePending = (
    sessionID: SessionSchema.ID,
    inboxID: SessionMessage.ID,
    mutation: (input: {
      readonly id: SessionMessage.ID
      readonly sessionID: SessionSchema.ID
    }) => Effect.Effect<void, SessionInbox.LifecycleConflict>,
  ) =>
    mutation({ sessionID, id: inboxID }).pipe(
      Effect.catchTag("SessionInbox.LifecycleConflict", () =>
        Effect.gen(function* () {
          yield* get(sessionID)
          return yield* new InboxConflictError({ sessionID, inboxID })
        }),
      ),
    )

  const inbox = Effect.fn("Session.inbox")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    return yield* admission.list(sessionID)
  })
  const cancelInbox = Effect.fn("Session.cancelInbox")(
    (sessionID: SessionSchema.ID, inboxID: SessionMessage.ID) => mutatePending(sessionID, inboxID, admission.cancel),
    Effect.uninterruptible,
  )
  const steerInbox = Effect.fn("Session.steerInbox")(function* (
    sessionID: SessionSchema.ID,
    inboxID: SessionMessage.ID,
  ) {
    yield* mutatePending(sessionID, inboxID, admission.steer)
    yield* execution.wake(sessionID)
  }, Effect.uninterruptible)
  const queueInbox = Effect.fn("Session.queueInbox")(
    (sessionID: SessionSchema.ID, inboxID: SessionMessage.ID) => mutatePending(sessionID, inboxID, admission.queue),
    Effect.uninterruptible,
  )
  const prompt = Effect.fn("Session.prompt")((sessionID: SessionSchema.ID, input: PromptRequest) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const session = yield* get(sessionID)
        const messageID = input.id ?? SessionMessage.ID.create()
        const admitted = yield* Effect.gen(function* () {
          // A retried ID returns its first admission without preparing a payload the runtime would refuse.
          const existing = yield* admission.admitted({
            id: messageID,
            sessionID: session.id,
            type: "user",
            delivery: input.delivery ?? "steer",
          })
          if (existing) return existing
          const prepared = yield* restore(
            Effect.gen(function* () {
              const preparation = yield* SessionPrompt.Service
              const references = yield* Reference.Service
              return { item: yield* preparation.prepare({ sessionID, messageID, input }), references }
            }).pipe(Effect.provide(servicesFor(session.location))),
          )
          // Commit a staged revert only after preparation succeeds, before admitting new work.
          if (session.revert) yield* SessionRevert.commit(bus, session)
          const admitted = yield* admission.admit({
            id: messageID,
            sessionID: session.id,
            item: prepared.item,
            ...(input.resume === false ? { resume: false } : {}),
          })
          yield* prepared.references.refresh()
          return admitted
        }).pipe(
          Effect.catchTag("SessionInbox.LifecycleConflict", () => new PromptConflictError({ sessionID, messageID })),
        )
        if (input.resume !== false) yield* execution.wake(sessionID)
        return admitted
      }),
    ),
  )
  const shell = Effect.fn("Session.shell")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: Event.ID; command: string },
  ) {
    const session = yield* get(sessionID)
    // The server owns completion recording even if the submitting client disconnects.
    const running = yield* Effect.gen(function* () {
      // Resolve shell services here without pinning Session events to this Location after a move.
      const shell = yield* Effect.gen(function* () {
        const plugins = yield* PluginSupervisor.Service
        yield* plugins.flush
        return yield* Shell.Service
      }).pipe(Effect.provide(servicesFor(session.location)))
      const started = yield* shell
        .create({
          command: input.command,
          cwd: session.location.directory,
          timeout: 0,
          metadata: { sessionID, background: true },
        })
        .pipe(
          Effect.tapError((error) =>
            synthetic(sessionID, {
              text: `User shell command failed to start:\n${input.command}\n\n${error.message}`,
              description: input.command,
              metadata: { source: "shell", state: "error" },
              resume: false,
            }),
          ),
          Effect.orDie,
        )
      yield* bus.publish(
        SessionEvent.Shell.Started,
        {
          sessionID,
          shell: started,
        },
        { id: input.id },
      )
      const terminal = yield* shell.result(started)
      const preview = yield* shell
        .output(started.id, { limit: SHELL_MAX_CAPTURE_BYTES })
        .pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(ShellResult.unavailable)))
      const info = terminal.info
      yield* bus.publish(SessionEvent.Shell.Settled, {
        sessionID,
        shellID: info.id,
        // `result` waits for the command to end, so its status is never still running.
        outcome: info.status === "running" ? "killed" : info.status,
        ...(info.exit === undefined ? {} : { exit: info.exit }),
        output: preview,
      })
      yield* synthetic(sessionID, {
        ...ShellResult.userNotification(terminal),
        resume: false,
      }).pipe(
        Effect.catchTag("Session.NotFoundError", () => Effect.void),
        Effect.orDie,
      )
    }).pipe(Effect.forkIn(scope, { startImmediately: true }))
    yield* Fiber.join(running)
  })
  const compact = Effect.fn("Session.compact")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: SessionMessage.ID; delivery?: SessionInbox.Delivery },
  ) {
    const session = yield* get(sessionID)
    if (session.revert) yield* SessionRevert.commit(bus, session)
    const inputID = input.id ?? SessionMessage.ID.create()
    const admitted = yield* admission
      .admitCompaction({
        id: inputID,
        sessionID,
        delivery: input.delivery ?? "steer",
      })
      .pipe(
        Effect.catchTag("SessionInbox.LifecycleConflict", () => new CompactionConflictError({ sessionID, inputID })),
      )
    yield* execution.wake(sessionID)
    return admitted
  })
  const wait = Effect.fn("Session.wait")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    yield* execution.awaitIdle(sessionID)
  })
  const resume = Effect.fn("Session.resume")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    yield* execution.resume(sessionID)
  })
  const synthetic = Effect.fn("Session.synthetic")(
    (
      sessionID: SessionSchema.ID,
      input: {
        id?: SessionMessage.ID
        text: string
        description?: string
        files?: ReadonlyArray<FileAttachment>
        metadata?: Record<string, unknown>
        delivery?: SessionInbox.Delivery
        resume?: boolean
        /**
         * Replaces the undelivered synthetic inputs admitted under the same key instead of queueing
         * beside them, so repeated notices from one source reach the model once. When it replaces any,
         * `merge` receives their payloads, oldest first, and returns what this input says instead.
         */
        coalesce?: {
          readonly key: string
          readonly merge: (
            replaced: ReadonlyArray<SessionInbox.SyntheticPayload>,
          ) => Pick<SessionInbox.SyntheticPayload, "text" | "description" | "metadata">
        }
      },
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const session = yield* get(sessionID)
          // A staged revert holds new notices until the user's next prompt commits or clears it.
          const resume = input.resume !== false && !session.revert
          const inputID = input.id ?? SessionMessage.ID.create()
          const admit = (
            payload: Pick<SessionInbox.SyntheticPayload, "text" | "description" | "metadata">,
            coalesce?: { readonly key: string; readonly replaces: ReadonlyArray<SessionMessage.ID> },
          ) =>
            admission.admit({
              id: inputID,
              sessionID,
              ...(coalesce === undefined ? {} : { coalesce }),
              ...(resume ? {} : { resume: false }),
              item: {
                type: "synthetic",
                payload: SessionInbox.SyntheticPayload.make({
                  text: payload.text,
                  description: payload.description,
                  files: input.files,
                  metadata: payload.metadata,
                }),
                delivery: SessionInbox.Delivery.make(input.delivery ?? "steer"),
              },
            })
          const coalesce = input.coalesce
          const admitted = yield* (
            coalesce === undefined
              ? admit(input)
              : Effect.gen(function* () {
                  const replaced = (yield* admission.list(sessionID)).filter(
                    (item): item is SessionInbox.Synthetic =>
                      item.type === "synthetic" && item.payload.metadata?.coalesce === coalesce.key,
                  )
                  const merged = replaced.length === 0 ? input : coalesce.merge(replaced.map((item) => item.payload))
                  // The runtime cancels the replaced items in the admission's own commit and marks it with the key.
                  return yield* admit(merged, { key: coalesce.key, replaces: replaced.map((item) => item.id) })
                }).pipe(
                  // The runtime refuses the replacement when the items under the key changed meanwhile (one was
                  // delivered, or another notice coalesced): read the inbox again.
                  Effect.retry({ times: 3, while: (error) => error._tag === "SessionInbox.LifecycleConflict" }),
                )
          ).pipe(
            Effect.catchTag("SessionInbox.LifecycleConflict", () => new SyntheticConflictError({ sessionID, inputID })),
          )
          if (resume) yield* execution.wake(sessionID)
          return admitted
        }),
      ),
  )
  const interrupt = Effect.fn("Session.interrupt")(
    (sessionID: SessionSchema.ID, options?: { readonly continue?: boolean }) =>
      Effect.uninterruptible(execution.interrupt(sessionID, options)),
  )
  /**
   * Appends a user-facing result to the timeline without waking or informing the model. Reusing an ID
   * that already names a displayed result in this Session returns it unchanged, so a retried call
   * publishes once.
   */
  const display = Effect.fn("Session.display")(function* (
    sessionID: SessionSchema.ID,
    input: SessionMessage.DisplayInput & { readonly id?: SessionMessage.ID },
  ) {
    yield* get(sessionID)
    if (input.id) {
      const stored = yield* store.message(input.id)
      if (stored?.sessionID === sessionID && stored.message.type === "display") return { id: input.id }
      if (stored) return yield* new DisplayConflictError({ sessionID, messageID: input.id })
    }
    const content = yield* Schema.decodeUnknownEffect(SessionMessage.DisplayInput)({
      ...(input.title === undefined ? {} : { title: input.title }),
      blocks: input.blocks,
    }).pipe(Effect.mapError((error) => new DisplayInvalidError({ message: error.message })))
    const problem = displayProblem(content)
    if (problem) return yield* new DisplayInvalidError({ message: problem })
    const eventID = input.id ? Event.ID.make("evt_" + input.id.slice("msg_".length)) : Event.ID.create()
    yield* bus.publish(SessionEvent.Displayed, { sessionID, ...content }, { id: eventID })
    return { id: SessionMessage.ID.fromEvent(eventID) }
  })
  const stage = Effect.fn("Session.revert.stage")(function* (
    sessionID: SessionSchema.ID,
    input: { messageID: SessionMessage.ID; files?: boolean },
  ) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    return yield* SessionRevert.Service.use((revert) =>
      revert.stage({ session, messageID: input.messageID, files: input.files }),
    ).pipe(Effect.provide(servicesFor(session.location)))
  })
  const clear = Effect.fn("Session.revert.clear")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    yield* SessionRevert.Service.use((revert) => revert.clear(session)).pipe(
      Effect.provide(servicesFor(session.location)),
    )
    return yield* execution.wake(sessionID)
  })
  const commit = Effect.fn("Session.revert.commit")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    return yield* SessionRevert.commit(bus, session)
  })
  const revert = { stage, clear, commit }
  const operations = {
    get,
    message,
    updateMessage,
    view,
    rename,
    switchAgent,
    selectTools,
    switchModel,
    inbox,
    prompt,
    synthetic,
    shell,
    compact,
    wait,
    resume,
    interrupt,
    display,
    cancelInbox,
    steerInbox,
    queueInbox,
    revert,
  }

  const forSession = (sessionID: SessionSchema.ID) => {
    const get = operations.get.bind(undefined, sessionID)
    const message = operations.message.bind(undefined, sessionID)
    const updateMessage = operations.updateMessage.bind(undefined, sessionID)
    const view = operations.view.bind(undefined, sessionID)
    const rename = operations.rename.bind(undefined, sessionID)
    const switchAgent = operations.switchAgent.bind(undefined, sessionID)
    const selectTools = operations.selectTools.bind(undefined, sessionID)
    const switchModel = operations.switchModel.bind(undefined, sessionID)
    const inbox = operations.inbox.bind(undefined, sessionID)
    const prompt = operations.prompt.bind(undefined, sessionID)
    const synthetic = operations.synthetic.bind(undefined, sessionID)
    const shell = operations.shell.bind(undefined, sessionID)
    const compact = operations.compact.bind(undefined, sessionID)
    const wait = operations.wait.bind(undefined, sessionID)
    const resume = operations.resume.bind(undefined, sessionID)
    const interrupt = operations.interrupt.bind(undefined, sessionID)
    const display = operations.display.bind(undefined, sessionID)
    const cancelInbox = operations.cancelInbox.bind(undefined, sessionID)
    const steerInbox = operations.steerInbox.bind(undefined, sessionID)
    const queueInbox = operations.queueInbox.bind(undefined, sessionID)
    const stage = operations.revert.stage.bind(undefined, sessionID)
    const clear = operations.revert.clear.bind(undefined, sessionID)
    const commit = operations.revert.commit.bind(undefined, sessionID)
    const revert = { stage, clear, commit }

    return {
      id: sessionID,
      get,
      message,
      updateMessage,
      view,
      rename,
      switchAgent,
      selectTools,
      switchModel,
      inbox,
      prompt,
      synthetic,
      shell,
      compact,
      wait,
      resume,
      interrupt,
      display,
      cancelInbox,
      steerInbox,
      queueInbox,
      revert,
    }
  }
  return { forSession }
})

export type Handle = ReturnType<Effect.Success<ReturnType<typeof make>>["forSession"]>

function isUnfinishedTool(content: SessionMessage.AssistantContent) {
  return content.type === "tool" && (content.state.status === "streaming" || content.state.status === "running")
}

/** Rules the schema cannot express per field: table keys that match their columns, and the total size. */
function displayProblem(content: SessionMessage.DisplayInput) {
  const table = content.blocks
    .map((block, index) => {
      if (block.type !== "table") return undefined
      const keys = new Set(block.columns.map((column) => column.key))
      if (keys.size !== block.columns.length) return "Block " + index + ": column keys must be unique."
      const row = block.rows.findIndex((cells) => Object.keys(cells).some((key) => !keys.has(key)))
      return row === -1 ? undefined : "Block " + index + ", row " + row + ": every key must name a column."
    })
    .find((problem) => problem !== undefined)
  if (table) return table
  const bytes = new TextEncoder().encode(JSON.stringify(content)).length
  if (bytes > SessionMessage.DisplayLimits.bytes)
    return (
      "A displayed result is limited to " +
      SessionMessage.DisplayLimits.bytes +
      " bytes of JSON; this one has " +
      bytes +
      "."
    )
  return undefined
}

// Mirrors the shell tool's in-memory preview safety limit.
const SHELL_MAX_CAPTURE_BYTES = 1024 * 1024
