export * as SessionRestart from "./restart.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Bus } from "../../bus.js"
import { Job } from "../../job.js"
import { Session } from "../../session.js"
import { SessionEvent } from "../event.js"
import { SessionExecution } from "../execution.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { ShellResult } from "../../shell/result.js"
import { SubagentCompletion } from "../subagent-completion.js"
import { CodeModeCompletion } from "../codemode-completion.js"
import { CodeModeResume } from "../../codemode/resume.js"
import { CodeModeStore } from "../../codemode/store.js"
import { CodeModeExecution } from "@ocpp/schema/codemode-execution"

const INTERRUPTED_WITHOUT_ERROR = "All fibers interrupted without error"

export interface Interface {
  /**
   * Recovers the background work a previous process left (shells, Code Mode runs, subagents): each
   * outcome reaches its owner as a notification, and a subagent still running resumes in the background.
   * An execution the previous process left running needs nothing here: the Specter runtime resumes it
   * from its own log, bounded by its retry budget for a step that keeps dying.
   */
  readonly resumeSuspendedSessions: Effect.Effect<void>
}

/**
 * Recovery for background work orphaned by a process that died or shut down. It needs no cooperation from
 * the previous process: the jobs table is the durable record. Recovery is at-least-once: local
 * coordination prevents concurrent runs, not repeated external side effects after a crash.
 *
 * The sweep assumes the previous process is dead. The managed-server protocol guarantees this: a successor
 * is only spawned after the previous process is confirmed dead (client service `kill`/`evict` poll the
 * PID), and the registration lock admits one managed server at a time. The service is inert until called
 * by its host at boot.
 */
export class Service extends Context.Service<Service, Interface>()("@ocpp/SessionRestart") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const execution = yield* SessionExecution.Service
    const bus = yield* Bus.Service
    const jobs = yield* Job.Service
    const sessions = yield* Session.Service
    const codemode = yield* CodeModeResume.Service
    const codemodeStore = yield* CodeModeStore.Service
    const scope = yield* Effect.scope

    const recoverShell = Effect.fnUntraced(function* (
      background: Job.Background,
      recovery: Extract<Job.Recovery, { kind: "shell" }>,
      resuming: ReadonlySet<SessionSchema.ID>,
    ) {
      const state = background.status === "running" ? "cancelled" : background.status
      const text =
        background.status === "running"
          ? "Command cancelled because the server restarted"
          : state === "completed"
            ? (background.output ?? "Command completed")
            : state === "error"
              ? (background.error ?? "Command failed")
              : "Command cancelled"

      yield* sessions
        .synthetic({
          id: background.notificationID,
          sessionID: recovery.sessionID,
          description: recovery.command,
          ...ShellResult.notification({
            jobID: background.id,
            shellID: recovery.shellID,
            command: recovery.command,
            state,
            text,
          }),
          ...(resuming.has(recovery.sessionID) ? { resume: false } : {}),
        })
        .pipe(
          Effect.catchTag("Session.NotFoundError", () => Effect.void),
          Effect.orDie,
        )
      yield* jobs.completeBackground(background.notificationID)
    })

    const recoverCodeMode = Effect.fnUntraced(function* (
      background: Job.Background,
      recovery: Extract<Job.Recovery, { kind: "codemode" }>,
      resuming: ReadonlySet<SessionSchema.ID>,
    ) {
      if (!(yield* store.get(recovery.parentSessionID))) {
        yield* jobs.completeBackground(background.notificationID)
        return
      }
      const restarted =
        background.status === "running" ||
        (background.status === "error" && background.error === INTERRUPTED_WITHOUT_ERROR)
      // A run the server stopped resumes by replaying its journal, and its own job then reports the
      // outcome through this same notification.
      const resumed = restarted
        ? yield* codemode.resume({ executionID: background.id, notificationID: background.notificationID })
        : undefined
      if (resumed?.resumed === true) return
      const status = restarted ? "error" : background.status
      const error =
        resumed?.resumed === false
          ? resumed.reason
          : background.status === "cancelled"
            ? (background.error ?? "Execution cancelled")
            : (background.error ?? "Execution failed")
      // Recording the outcome makes the background job terminal (JobProjector).
      const terminal = background.terminal === true
      if (!terminal && status === "completed") {
        yield* bus.publish(SessionEvent.CodeMode.Completed, {
          sessionID: recovery.parentSessionID,
          assistantMessageID: recovery.assistantMessageID,
          id: recovery.toolCallID,
          executionID: CodeModeExecution.ID.make(background.id),
          events: [],
        })
      }
      if (!terminal && (status === "error" || status === "cancelled")) {
        yield* bus.publish(SessionEvent.CodeMode.Failed, {
          sessionID: recovery.parentSessionID,
          assistantMessageID: recovery.assistantMessageID,
          id: recovery.toolCallID,
          executionID: CodeModeExecution.ID.make(background.id),
          events: [],
          status,
          error,
        })
      }
      // The journal outlives the execution's settlement, so the child sessions its calls named are
      // listed here as the live run would have, with calls that never settled as interrupted.
      const children = yield* codemodeStore.children(background.id)
      yield* CodeModeCompletion.deliver(sessions, jobs, {
        id: background.id,
        status,
        notificationID: background.notificationID,
        ...(background.output === undefined ? {} : { output: background.output }),
        error,
        recovery,
        ...(children.length === 0 ? {} : { children }),
        resume: resuming.has(recovery.parentSessionID) ? false : undefined,
      }).pipe(
        Effect.catchTag("Session.NotFoundError", () => jobs.completeBackground(background.notificationID)),
        Effect.orDie,
      )
    })

    const recoverSubagent = Effect.fnUntraced(function* (
      background: Job.Background,
      recovery: Extract<Job.Recovery, { kind: "subagent" }>,
      resuming: ReadonlySet<SessionSchema.ID>,
    ) {
      const child = yield* store.get(recovery.childSessionID)
      if (!child || child.parentID !== recovery.parentSessionID || !(yield* store.get(recovery.parentSessionID))) {
        yield* jobs.completeBackground(background.notificationID)
        return
      }

      const notify = Effect.fnUntraced(function* (result: Pick<Job.Background, "status" | "output" | "error">) {
        yield* SubagentCompletion.deliver(sessions, jobs, {
          ...result,
          recovery,
          notificationID: background.notificationID,
          resume: resuming.has(recovery.parentSessionID) ? false : undefined,
        }).pipe(Effect.orDie)
      })

      if (background.status !== "running") {
        yield* notify(background)
        return
      }

      // A child the stopped process left mid-execution is already active again: the runtime resumed it from
      // its log at boot. Its job joins that execution, which is how the parent hears how it ended.
      yield* jobs.start({
        id: background.id,
        type: "subagent",
        title: recovery.description,
        notificationID: background.notificationID,
        recovery,
        run: execution.resume(recovery.childSessionID).pipe(
          Effect.andThen(store.context(recovery.childSessionID)),
          Effect.map((messages) => {
            const assistant = messages.findLast(
              (message) =>
                message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
            )
            if (assistant?.type !== "assistant") return "Subagent completed without a text response."
            return (
              assistant.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("") || "Subagent completed without a text response."
            )
          }),
        ),
      })
      yield* jobs.background(background.id)
      yield* jobs.wait({ id: background.id }).pipe(
        Effect.flatMap((result) => (result.info ? notify(result.info) : Effect.void)),
        Effect.forkIn(scope),
      )
    })

    return Service.of({
      resumeSuspendedSessions: Effect.gen(function* () {
        const pending = yield* jobs.pendingBackground
        // A subagent child still running resumes here; notices to it wait for that rather than waking it.
        const resuming = new Set(
          pending.flatMap((background) =>
            background.status === "running" && background.recovery.kind === "subagent"
              ? [background.recovery.childSessionID]
              : [],
          ),
        )
        yield* Effect.forEach(
          // Admit shell outcomes before a recovered child can start its first model request.
          pending.toSorted((a, b) => Number(a.recovery.kind === "subagent") - Number(b.recovery.kind === "subagent")),
          Effect.fnUntraced(function* (background) {
            if ((yield* jobs.get(background.id))?.status === "running") return
            const recovery = background.recovery
            switch (recovery.kind) {
              case "shell":
                yield* recoverShell(background, recovery, resuming)
                return
              case "codemode":
                yield* recoverCodeMode(background, recovery, resuming)
                return
              case "subagent":
                yield* recoverSubagent(background, recovery, resuming)
                return
            }
          }),
          { discard: true },
        )
        // Async observers consult this set at delivery; later completions wake their owners normally.
        resuming.clear()
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    SessionStore.node,
    SessionExecution.node,
    Bus.node,
    Job.node,
    Session.node,
    CodeModeResume.node,
    CodeModeStore.node,
  ],
})
