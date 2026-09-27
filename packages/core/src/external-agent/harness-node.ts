export * as ExternalAgentHarnessNode from "./harness-node.js"

import { Message } from "@ocpp/ai"
import { ExternalSession } from "@ocpp/schema/external-session"
import { SessionDriver } from "@ocpp/schema/session-driver"
import type { SessionError } from "@ocpp/schema/session-error"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { FSUtil } from "@ocpp/util/fs-util"
import { Hash } from "@ocpp/util/hash"
import { Cause, Context, Deferred, Effect, Exit, FiberMap, Layer, Schema } from "effect"
import path from "path"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Database } from "../database/database.js"
import { Instructions } from "../instructions/index.js"
import { LocationMutation } from "../location-mutation.js"
import { Permission } from "../permission.js"
import { SessionContext } from "../session/context.js"
import { StepFailedError } from "../session/error.js"
import { ExternalAgentHarness } from "./harness.js"
import { SessionEvent } from "../session/event.js"
import { SessionInbox } from "../session/inbox.js"
import { SessionMessage } from "../session/message.js"
import { SessionModelRequest } from "../session/model-request.js"
import { DrainResult } from "../session/runner/index.js"
import { settleStaleToolCalls } from "../session/runner/stale.js"
import { toLLMMessages } from "../session/runner/to-llm-message.js"
import { SessionSchema } from "../session/schema.js"
import { SessionStore } from "../session/store.js"
import { SessionTitle } from "../session/title.js"
import { toSessionError } from "../session/to-session-error.js"
import { Tool } from "../tool.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { definition, execute } from "../tool/runtime.js"
import { Wildcard } from "../util/wildcard.js"
import { ExternalAgentDriver } from "./driver.js"
import { ExternalAgentDrivers } from "./drivers.js"
import { ExternalAgentGateway } from "./gateway.js"
import { ExternalAgentSession } from "./session.js"
import { ExternalAgentStream } from "./stream.js"

const layer = Layer.effect(
  ExternalAgentHarness.Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db
    const store = yield* SessionStore.Service
    const external = yield* ExternalAgentSession.Service
    const context = yield* SessionContext.Service
    const drivers = yield* ExternalAgentDrivers.Service
    const permission = yield* Permission.Service
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const title = yield* SessionTitle.Service
    // Title generation starts once input is visible and must not delay the vendor.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    const drain = Effect.fn("ExternalAgentHarness.drain")(function* (
      input: Parameters<ExternalAgentHarness.Interface["drain"]>[0],
    ) {
      const sessionID = input.sessionID
      const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
      const control = pending?.type === "compaction" || pending?.type === "move"
      if (
        !input.force &&
        (pending === undefined || (input.promotable === "steer" && pending.delivery === "queue" && !control))
      )
        return DrainResult.Complete()
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      const provider = SessionDriver.of(session.model)
      if (provider === "ocpp" || session.model === undefined)
        return yield* Effect.die(new Error(`Session is not vendor-driven: ${sessionID}`))
      const model = session.model
      const directory = session.location.directory
      const activation = yield* external.activation(sessionID)
      // Only a subagent call may run a vendor natively; everything else, including every top-level Session, is harnessed.
      const harness = activation?.harness ?? "ocpp"
      const sdk = yield* drivers
        .driver(provider)
        .pipe(
          Effect.mapError(
            (error) => new StepFailedError({ error: { type: "driver.unavailable", message: error.message } }),
          ),
        )
      yield* settleStaleToolCalls(store, bus, sessionID)
      const selection = yield* context.select(sessionID)
      const agent = selection.agent.id
      const system = SessionModelRequest.systemPrompt({
        agent: selection.agent.info,
        tools: selection.tools,
        initial: yield* Instructions.renderCurrent(selection.instructions),
      }).join("\n\n")
      const stream = ExternalAgentStream.make(bus, sessionID, agent, model)

      // Rung by every admission to this Session's inbox; a waiter captures the bell before checking its condition.
      const bell = { current: Deferred.makeUnsafe<void>() }
      const ring = Effect.suspend(() => {
        const rung = bell.current
        bell.current = Deferred.makeUnsafe<void>()
        return Deferred.succeed(rung, undefined)
      })
      // Executions this drain started are owed a completion notification before the vendor may go idle.
      const executions = { launched: new Set<string>(), notified: new Set<string>() }
      yield* Effect.acquireRelease(
        bus.listen((event) => {
          if (!isEnqueued(event) || event.data.sessionID !== sessionID) return Effect.void
          const item = event.data.item
          const executionID = item.type === "synthetic" ? item.payload.metadata?.executionID : undefined
          if (typeof executionID === "string") executions.notified.add(executionID)
          return ring.pipe(Effect.asVoid)
        }),
        (unsubscribe) => unsubscribe,
      )
      const state = { idle: true, moved: false, started: false, vendor: undefined as string | undefined }

      const deliver = Effect.fnUntraced(function* (items: ReadonlyArray<SessionInbox.Info>) {
        const messages = yield* Effect.forEach(items, (item) => store.message(item.id))
        return messages
          .flatMap((stored) => (stored === undefined ? [] : toLLMMessages([stored.message], model)))
          .map(render)
          .filter((text) => text.length > 0)
          .join("\n\n")
      })
      // Steers join a running vendor turn; at idle, queued input and control items are handled as the runner does.
      const take = (scope: SessionInbox.Promotable): Effect.Effect<string | undefined> =>
        Effect.gen(function* () {
          while (true) {
            const rung = bell.current
            if (state.idle) {
              const next = yield* SessionInbox.nextPromotable(db, sessionID, scope)
              if (next?.type === "move") {
                state.moved = true
                return undefined
              }
              if (next?.type === "compaction") {
                yield* refuseCompaction(sessionID, next.id, provider)
                continue
              }
            }
            const items = yield* SessionInbox.promoteItems(db, bus, sessionID, state.idle ? scope : "steer")
            if (items.length > 0) {
              state.idle = false
              return yield* deliver(items)
            }
            if (state.idle && [...executions.launched].every((id) => executions.notified.has(id))) return undefined
            yield* Deferred.await(rung)
          }
        })

      const invokeExecute = Effect.fnUntraced(function* (value: Record<string, unknown>, id?: string) {
        const call = yield* stream.claim({ id, input: value })
        const exit = yield* selection.tools
          .execute({
            sessionID,
            agent,
            messageID: call.messageID,
            call: { type: "tool-call", id: call.id, name: "execute", input: value },
            progress: (update) => stream.progress(call, update),
          })
          .pipe(Effect.exit)
        if (Exit.isSuccess(exit)) {
          const executionID = exit.value.metadata?.executionID
          // Recorded before the settlement that lets the execution start, so its notification cannot be missed.
          if (typeof executionID === "string") executions.launched.add(executionID)
          yield* stream.settle(call, { _tag: "Success", result: exit.value })
          return text(exit.value.content)
        }
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
        const failure = Cause.squash(exit.cause)
        const error: SessionError.Error =
          failure instanceof Permission.DeclinedError || failure instanceof QuestionTool.CancelledError
            ? { type: "aborted", message: "The user declined this tool call" }
            : toSessionError(failure)
        yield* stream.settle(call, {
          _tag: "Failure",
          error,
          ...(failure instanceof Tool.Error && failure.metadata !== undefined ? { metadata: failure.metadata } : {}),
        })
        return yield* Effect.fail(error.message)
      })
      const execution = selection.tools.definitions.find((tool) => tool.name === "execute")
      const gateway = ExternalAgentGateway.make([
        ...(execution === undefined
          ? []
          : [
              {
                name: "execute",
                description: execution.description,
                inputSchema: execution.inputSchema as Record<string, Schema.Json>,
                invoke: invokeExecute,
              },
            ]),
        // The native harness also offers the call's own tools directly; they stay reachable from execute too.
        ...(harness === "native" ? (activation?.tools ?? []) : []).flatMap((tool) => {
          const described = definition(tool)
          if (described.inputSchema.type !== "object") return []
          return [
            {
              name: described.name,
              description: described.description,
              inputSchema: described.inputSchema as Record<string, Schema.Json>,
              invoke: (value: Record<string, unknown>, id?: string) =>
                execute(tool, value, {
                  sessionID,
                  agent,
                  messageID: stream.source(id)?.messageID ?? SessionMessage.ID.create(),
                  id: Tool.CallID.make(id ?? crypto.randomUUID()),
                  progress: () => Effect.void,
                }).pipe(
                  Effect.map((result) => text(result.content)),
                  Effect.mapError((error) => error.message),
                ),
            },
          ]
        }),
      ])
      const authorize = native({ session, provider, selection, permission, fs, config, stream })

      const bind = Effect.fnUntraced(function* () {
        const record = yield* external.get(sessionID)
        if (record?.provider === provider && record.directory === directory) return record
        yield* bus.publish(ExternalSession.Bound, { sessionID, provider, directory })
        return (yield* external.get(sessionID))!
      })
      // A vendor session continues only when it holds exactly the canonical history OC++ last checkpointed.
      // Anything else (a missing or divergent vendor session, or OC++ history written by another driver) starts a
      // new vendor session rebuilt from canonical history.
      const resumable = Effect.fnUntraced(function* (record: ExternalSession.Info, settled: string) {
        if (state.vendor !== undefined) return state.vendor
        if (record.vendorSessionID === undefined || record.historyHash !== settled) return undefined
        const vendorSessionID = record.vendorSessionID
        const checkpoint = yield* Effect.tryPromise((signal) => sdk.inspect(directory, vendorSessionID, signal)).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Vendor history is unreadable; rebuilding", { sessionID, error }),
          ),
          Effect.orElseSucceed(() => undefined),
        )
        return checkpoint !== undefined && checkpoint === record.checkpoint ? vendorSessionID : undefined
      })
      const move = SessionInbox.serialized(
        sessionID,
        Effect.gen(function* () {
          const next = yield* SessionInbox.nextPromotable(db, sessionID, "input")
          if (next?.type !== "move") return DrainResult.Complete()
          yield* bus.publishAll([
            [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
            [SessionEvent.Moved, { sessionID, ...next.payload }],
          ])
          return DrainResult.Moved({})
        }),
      )

      const scope = { next: input.promotable ?? "input" }
      while (true) {
        const history = canonical(yield* store.context(sessionID))
        const answered = history.findLastIndex((item) => item.role === "assistant") + 1
        const settled = history.slice(0, answered)
        // Input admitted before a restart or failure that the vendor never answered is delivered again, once.
        const unanswered = state.started ? [] : history.slice(answered).map((item) => item.text)
        state.started = true
        const record = yield* bind()
        const vendorSessionID = yield* resumable(record, Hash.sha256(JSON.stringify(settled)))
        const next = yield* take(scope.next)
        scope.next = "input"
        if (state.moved) return yield* move
        const message = [...unanswered, ...(next === undefined ? [] : [next])].join("\n\n")
        if (message.length === 0) return DrainResult.Complete()
        state.idle = false
        if (!session.parentID && SessionTitle.isUntitled(session))
          yield* FiberMap.run(titles, sessionID, title.generate(sessionID), { onlyIfMissing: true })
        const checkpoint = { value: undefined as string | undefined, vendor: vendorSessionID }
        yield* ExternalAgentDriver.execute(sdk, {
          directory,
          model: model.id,
          // The "default" variant is OC++'s name for no explicit effort.
          effort: model.variant === "default" ? undefined : model.variant,
          vendorSessionID,
          history: vendorSessionID === undefined ? settled : [],
          message,
          harness: harness === "ocpp" ? { type: "ocpp", system } : { type: "native" },
          gateway,
          authorize: (name, value, signal, toolID, cwd) =>
            Effect.runPromise(authorize(name, value, toolID, cwd), { signal }),
          emit: (event) => Effect.runPromise(stream.emit(event).pipe(Effect.asVoid)),
          linked: (id) => {
            checkpoint.vendor = id
            return id === record.vendorSessionID
              ? Promise.resolve()
              : Effect.runPromise(
                  bus.publish(ExternalSession.Linked, { sessionID, vendorSessionID: id }).pipe(Effect.asVoid),
                )
          },
          checkpointed: async (value) => {
            checkpoint.value = value
          },
          // A run being aborted takes no further input: Effect evaluates a synchronous take before it observes an
          // already-aborted signal, which would hand the next call's input to the run it is replacing.
          next: (signal) => (signal.aborted ? Promise.resolve(undefined) : Effect.runPromise(take("input"), { signal })),
          idle: () => {
            state.idle = true
            Effect.runSync(ring)
          },
        }).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              yield* stream.finish(
                Exit.isSuccess(exit)
                  ? undefined
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? new StepFailedError({ error: { type: "aborted", message: "Step interrupted" } })
                    : Cause.squash(exit.cause),
              )
              if (Object.keys(stream.diagnostics()).length > 0)
                yield* Effect.logDebug("External SDK diagnostics", {
                  sessionID,
                  provider,
                  events: stream.diagnostics(),
                })
              if (checkpoint.value === undefined) return
              const history = canonical(yield* store.context(sessionID))
              yield* bus.publish(ExternalSession.Checkpointed, {
                sessionID,
                checkpoint: checkpoint.value,
                historyHash: Hash.sha256(
                  JSON.stringify(history.slice(0, history.findLastIndex((item) => item.role === "assistant") + 1)),
                ),
              })
            }),
          ),
          Effect.mapError((error) => new StepFailedError({ error: toSessionError(error) })),
        )
        state.vendor = checkpoint.vendor
        state.idle = true
        if (state.moved) return yield* move
      }
    }, Effect.scoped)

    const refuseCompaction = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      inputID: SessionMessage.ID,
      provider: ExternalSession.Provider,
    ) {
      yield* SessionInbox.serialized(
        sessionID,
        bus.publishAll([
          [SessionEvent.InboxDelivered, { sessionID, inboxID: inputID }],
          [SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "", inputID }],
        ]),
      )
      yield* bus.publish(SessionEvent.Compaction.Failed, {
        sessionID,
        reason: "manual",
        error: {
          type: "compaction.unsupported",
          message: `${SessionDriver.names[provider]} manages its own context; OC++ compaction does not apply to this session.`,
        },
        inputID,
      })
    })

    return ExternalAgentHarness.Service.of({ drain })
  }),
)

/** Authorizes the vendor's own tool calls in the native harness, through OC++ permissions. */
function native(input: {
  readonly session: SessionSchema.Info
  readonly provider: ExternalSession.Provider
  readonly selection: SessionContext.Selection
  readonly permission: Permission.Interface
  readonly fs: FSUtil.Interface
  readonly config: Config.Interface
  readonly stream: ReturnType<typeof ExternalAgentStream.make>
}) {
  const directory = input.session.location.directory
  const provider = input.provider
  const agent = input.selection.agent.id
  // Session-wide grants are asked of the caller, like the subagent call that requested the native harness.
  const owner = input.session.parentID ?? input.session.id
  return Effect.fnUntraced(function* (name: string, value: Record<string, unknown>, toolID?: string, cwd?: string) {
    const entries = yield* input.config.entries()
    if (provider === "codex" && name === "workspace")
      for (const action of ["read", "edit", "shell"])
        yield* input.permission.assert({
          action,
          sessionID: owner,
          agent,
          save: [],
          resources: [
            "*",
            ...input.selection.agent.info.permissions
              .filter((rule) => Wildcard.match(action, rule.action) && rule.effect !== "allow")
              .map((rule) => rule.resource),
          ],
          metadata: {
            provider,
            directory,
            delegation:
              "Codex native tools require authorization for their entire sandbox scope because its execution SDK has no per-tool approval callback.",
          },
        })
    const source = input.stream.source(toolID)
    const common = {
      sessionID: source === undefined ? owner : input.session.id,
      agent,
      ...(source === undefined ? {} : { source }),
      metadata: { provider, tool: name, directory },
      save: [],
    }
    const selected = action(provider, name)
    const workingDirectory = cwd === undefined ? directory : yield* input.fs.resolve(cwd)
    const command =
      selected !== "shell" || typeof value.command !== "string"
        ? undefined
        : yield* Effect.gen(function* () {
            const { ShellParse } = yield* Effect.promise(() => import("../shell/parse.js"))
            return yield* ShellParse.scan(
              value.command as string,
              name === "powershell" ? "powershell" : "bash",
              workingDirectory,
              { portable: Config.latest(entries, "experimental")?.portable_shell_scanner === true },
            )
          })
    const file = value.file_path ?? value.path
    const absolute =
      typeof file === "string"
        ? yield* input.fs.resolve(LocationMutation.resolvePath(workingDirectory, file))
        : undefined
    const paths = [
      workingDirectory,
      ...(absolute === undefined || FSUtil.contains(directory, absolute)
        ? []
        : [(yield* input.fs.isDir(absolute)) ? absolute : path.dirname(absolute)]),
      ...(command?.directories ?? []),
    ]
    const resolved = yield* Effect.forEach(paths, (value) =>
      input.fs.resolve(LocationMutation.resolvePath(workingDirectory, value)),
    )
    const outside = resolved.filter((value) => !FSUtil.contains(directory, value))
    if (outside.length > 0)
      yield* input.permission.assert({
        ...common,
        action: "external_directory",
        resources: outside.map((value) => path.join(value, "*").replaceAll("\\", "/")),
      })
    yield* input.permission.assert({
      ...common,
      action: selected,
      resources: command?.commands.length
        ? command.commands.map((item) => item.resource)
        : [
            absolute === undefined
              ? resource(directory, value)
              : (FSUtil.contains(directory, absolute)
                  ? path.relative(directory, absolute) || "."
                  : absolute
                ).replaceAll("\\", "/"),
          ],
    })
  })
}

function action(provider: ExternalSession.Provider, name: string) {
  if (["Bash", "bash", "powershell", "command_execution"].includes(name)) return "shell"
  if (["Read", "read"].includes(name)) return "read"
  if (["Glob", "ls", "find"].includes(name)) return "glob"
  if (["Grep", "grep"].includes(name)) return "grep"
  if (["Edit", "Write", "NotebookEdit", "edit", "write", "file_change"].includes(name)) return "edit"
  if (name === "WebFetch") return "webfetch"
  if (name === "WebSearch") return "websearch"
  if (name === "Skill") return "skill"
  return `${provider}_${name}`
}

function resource(directory: string, value: Record<string, unknown>) {
  const file = value.file_path ?? value.path
  if (typeof file === "string") return LocationMutation.resolvePath(directory, file)
  if (typeof value.command === "string") return value.command
  if (typeof value.url === "string") return value.url
  return directory
}

/** Canonical OC++ history as the vendor reads it when a vendor session is rebuilt, and as its checkpoints hash it. */
function canonical(messages: ReadonlyArray<SessionMessage.Info>): ExternalAgentDriver.History[] {
  return messages.flatMap((message): ExternalAgentDriver.History[] => {
    if (message.type === "user" || message.type === "synthetic") return [{ role: "user", text: message.text }]
    if (message.type !== "assistant") return []
    return [
      {
        role: "assistant",
        text: message.content
          .map((part) => (part.type === "text" || part.type === "reasoning" ? part.text : JSON.stringify(part)))
          .join("\n"),
      },
    ]
  })
}

function isEnqueued(event: Bus.LogItem): event is SessionEvent.InboxEnqueued {
  return event.type === SessionEvent.InboxEnqueued.type
}

/** Delivered input as the native runner lowers it, reduced to text: media cannot cross the vendor boundary yet. */
function render(message: Message) {
  if (typeof message.content === "string") return message.content
  const media = message.content.filter((part) => part.type === "media").length
  return [
    ...message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    ...(media === 0
      ? []
      : [`[${media} attached image or PDF ${media === 1 ? "file was" : "files were"} not forwarded]`]),
  ].join("")
}

function text(content: string | ReadonlyArray<Tool.Content> | undefined) {
  if (content === undefined) return "Completed."
  if (typeof content === "string") return content
  return (
    content.map((part) => (part.type === "text" ? part.text : `[${part.mime} attachment]`)).join("\n") || "Completed."
  )
}

export const node = makeLocationNode({
  service: ExternalAgentHarness.Service,
  layer,
  deps: [
    Bus.node,
    Database.node,
    SessionStore.node,
    ExternalAgentSession.node,
    SessionContext.node,
    ExternalAgentDrivers.node,
    Permission.node,
    Config.node,
    FSUtil.node,
    SessionTitle.node,
  ],
})
