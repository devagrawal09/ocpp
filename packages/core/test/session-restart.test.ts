import { describe, expect, test } from "bun:test"
import { AIError, TransportError } from "@ocpp/ai"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Bus } from "@ocpp/core/bus"
import { Job } from "@ocpp/core/job"
import { CodeModeExecution } from "@ocpp/schema/codemode-execution"
import { CodeModeResume } from "@ocpp/core/codemode/resume"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { KV } from "@ocpp/core/kv"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import type { LocationServices } from "@ocpp/core/location-services"
import { Project } from "@ocpp/core/project"
import { ProjectTable } from "@ocpp/core/project/sql"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { ExternalAgentSession } from "@ocpp/core/external-agent/session"
import { SessionExecution } from "@ocpp/core/session/execution"
import { SessionRestart } from "@ocpp/core/session/execution/restart"
import { UserInterruptedError } from "@ocpp/core/session/error"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionInbox } from "@ocpp/core/session/inbox"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionInboxTable, SessionTable } from "@ocpp/core/session/sql"
import { SessionStore } from "@ocpp/core/session/store"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Scope } from "effect"
import { and, eq } from "drizzle-orm"
import { EventTable } from "@ocpp/core/event/sql"
import { SpecterEventTable } from "@ocpp/core/specter/sql"
import { Recorded } from "./lib/recorded"
import { TestStepHost } from "./fixture/step-host"
import { testEffect } from "./lib/effect"

// The runtime runs every Session; a step produces nothing unless a test scripts one.
const steps = TestStepHost.make()
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      SessionInbox.node,
      SessionExecution.node,
      Job.node,
      KV.node,
      Session.node,
      CodeModeStore.node,
    ]),
    [steps.replacement],
  ),
)

describe("SessionRestart background recovery", () => {
  it.effect("does not resume a user-cancelled background child whose notification was not admitted", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const parent = Session.ID.make("ses_cancelled_background_parent")
      const child = Session.ID.make("ses_cancelled_background_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })

      // The process before the restart: its jobs are the ones a user interrupt cancels through the runtime.
      const running = steps.hold(child)
      const jobs = yield* Job.Service
      const execution = yield* SessionExecution.Service
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "general",
          description: "Cancelled inspection",
        },
        run: execution.resume(child).pipe(Effect.as("unused")),
      })
      yield* jobs.background(child)
      yield* running.started
      expect(yield* execution.interrupt(child)).toBeTrue()
      yield* execution.awaitIdle(child)
      expect((yield* jobs.wait({ id: child })).info?.status).toBe("cancelled")
      expect(yield* jobs.pendingBackground).toMatchObject([{ id: child, status: "cancelled" }])

      const restartedScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(restartedScope, Exit.void))
      const restartedJobs = yield* Job.make.pipe(Scope.provide(restartedScope))
      const restarted = yield* buildRestart(restartedScope, restartedJobs)
      yield* Context.get(restarted, SessionRestart.Service).resumeSuspendedSessions
      yield* Context.get(restarted, SessionExecution.Service).awaitIdle(parent)
      // Recovery woke the parent alone, and its execution delivered the notice.
      expect(yield* executions(parent)).toBe(1)
      expect(yield* executions(child)).toBe(1)
      expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
      expect(yield* syntheticMessages(parent)).toMatchObject([
        { text: expect.stringContaining("Subagent cancelled"), metadata: { state: "cancelled" } },
      ])
      expect(yield* restartedJobs.pendingBackground).toEqual([])
    }),
  )

  it.effect("wakes idle shell owners and delivers recovered notices exactly once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_background_recovery_parent")
      const child = Session.ID.make("ses_background_recovery_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      yield* seedBackground(jobs, parent, [
        { id: "sh_background_orphan", shellID: "sh_background_orphan", command: "sleep 60" },
      ])
      yield* seedBackground(jobs, child, [{ id: "call-child-shell", shellID: "sh_child_orphan", command: "sleep 30" }])

      expect(yield* jobs.pendingBackground).toHaveLength(2)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildRestart(scope, restarted)
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)
      yield* restart.resumeSuspendedSessions
      yield* Effect.forEach([parent, child], execution.awaitIdle, { discard: true })

      expect(yield* executions(parent)).toBe(1)
      expect(yield* executions(child)).toBe(1)
      expect((yield* store.context(parent)).filter((message) => message.type === "synthetic")).toMatchObject([
        {
          type: "synthetic",
          description: "sleep 60",
          text: expect.stringContaining("server restarted"),
          metadata: {
            source: "shell",
            jobID: "sh_background_orphan",
            shellID: "sh_background_orphan",
            state: "cancelled",
          },
        },
      ])
      expect((yield* store.context(child)).filter((message) => message.type === "synthetic")).toMatchObject([
        {
          type: "synthetic",
          metadata: {
            source: "shell",
            jobID: "call-child-shell",
            shellID: "sh_child_orphan",
            state: "cancelled",
          },
        },
      ])
      expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
      expect(yield* SessionInbox.list(database.db, child)).toEqual([])
      expect(yield* restarted.pendingBackground).toEqual([])

      yield* restart.resumeSuspendedSessions
      yield* Effect.forEach([parent, child], execution.awaitIdle, { discard: true })
      expect(yield* executions(parent)).toBe(1)
      expect(yield* executions(child)).toBe(1)
      expect((yield* store.context(parent)).filter((message) => message.type === "synthetic")).toHaveLength(1)
      expect((yield* store.context(child)).filter((message) => message.type === "synthetic")).toHaveLength(1)
    }),
  )

  it.effect("fails stale Code Mode work and admits one recovery steer", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const bus = yield* Bus.Service
      const sessionID = Session.ID.make("ses_codemode_recovery")
      const executionID = CodeModeExecution.ID.make("exe_codemode_recovery")
      const assistantMessageID = SessionMessage.ID.make("msg_codemode_recovery")
      yield* seedSessions(database, [sessionID])
      yield* jobs.start({
        id: executionID,
        type: "codemode",
        recovery: {
          kind: "codemode",
          parentSessionID: sessionID,
          assistantMessageID,
          toolCallID: "call-codemode-recovery",
        },
        run: Effect.never,
      })
      yield* jobs.background(executionID)

      const failed: SessionEvent.CodeMode.Failed[] = []
      yield* bus.project(SessionEvent.CodeMode.Failed, (event) => Effect.sync(() => void failed.push(event)))
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Scope.provide(scope))
      const context = yield* buildRestart(scope, restarted)
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)
      yield* restart.resumeSuspendedSessions
      yield* execution.awaitIdle(sessionID)

      expect(failed).toMatchObject([
        {
          data: {
            sessionID,
            assistantMessageID,
            id: "call-codemode-recovery",
            executionID,
            events: [],
            status: "error",
            error: "Execution failed because the server restarted.",
          },
        },
      ])
      expect(yield* executions(sessionID)).toBe(1)
      expect(yield* syntheticMessages(sessionID)).toMatchObject([
        {
          text: "Execution failed because the server restarted.",
          metadata: { source: "codemode", executionID, state: "failed" },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])

      yield* restart.resumeSuspendedSessions
      expect(failed).toHaveLength(1)
      expect(yield* executions(sessionID)).toBe(1)

      const interruptedID = CodeModeExecution.ID.make("exe_codemode_interrupted_recovery")
      yield* jobs.start({
        id: interruptedID,
        type: "codemode",
        recovery: {
          kind: "codemode",
          parentSessionID: sessionID,
          assistantMessageID,
          toolCallID: "call-codemode-interrupted-recovery",
        },
        run: Effect.fail(new Error("All fibers interrupted without error")),
      })
      yield* jobs.background(interruptedID)
      yield* jobs.wait({ id: interruptedID })
      expect((yield* jobs.pendingBackground).find((item) => item.id === interruptedID)).toMatchObject({
        status: "error",
        error: "All fibers interrupted without error",
      })

      yield* restart.resumeSuspendedSessions
      yield* execution.awaitIdle(sessionID)
      expect(failed.at(-1)).toMatchObject({
        data: {
          executionID: interruptedID,
          status: "error",
          error: "Execution failed because the server restarted.",
        },
      })
      expect(yield* executions(sessionID)).toBe(2)
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect("acknowledges an already delivered Code Mode terminal without waking again", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      const sessionID = Session.ID.make("ses_codemode_delivered")
      const executionID = CodeModeExecution.ID.make("exe_codemode_delivered")
      yield* seedSessions(database, [sessionID])
      yield* jobs.start({
        id: executionID,
        type: "codemode",
        recovery: {
          kind: "codemode",
          parentSessionID: sessionID,
          assistantMessageID: SessionMessage.ID.make("msg_codemode_delivered"),
          toolCallID: "call-codemode-delivered",
        },
        run: Effect.never,
      })
      yield* jobs.background(executionID)
      const background = (yield* jobs.pendingBackground)[0]
      if (!background) return yield* Effect.die("Code Mode background marker is unavailable")
      yield* jobs.markBackgroundTerminal(background.notificationID)
      const failed: SessionEvent.CodeMode.Failed[] = []
      yield* bus.project(SessionEvent.CodeMode.Failed, (event) => Effect.sync(() => void failed.push(event)))
      yield* sessions.synthetic({
        id: background.notificationID,
        sessionID,
        text: "Execution already delivered",
        metadata: { source: "codemode", executionID, state: "error" },
        resume: false,
      })
      yield* sessions.resume(sessionID)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Scope.provide(scope))
      const context = yield* buildRestart(scope, restarted)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Context.get(context, SessionExecution.Service).awaitIdle(sessionID)

      // Only the execution that delivered it: recovery woke nothing.
      expect(yield* executions(sessionID)).toBe(1)
      expect(failed).toEqual([])
      expect(yield* sessions.messages({ sessionID })).toMatchObject([
        { id: background.notificationID, type: "synthetic", text: "Execution already delivered" },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect("delivers a committed Code Mode terminal after a crash without publishing it again", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const bus = yield* Bus.Service
      const sessionID = Session.ID.make("ses_codemode_terminal_crash")
      const executionID = CodeModeExecution.ID.make("exe_codemode_terminal_crash")
      yield* seedSessions(database, [sessionID])
      yield* jobs.start({
        id: executionID,
        type: "codemode",
        recovery: {
          kind: "codemode",
          parentSessionID: sessionID,
          assistantMessageID: SessionMessage.ID.make("msg_codemode_terminal_crash"),
          toolCallID: "call-codemode-terminal-crash",
        },
        run: Effect.never,
      })
      yield* jobs.background(executionID)
      const background = (yield* jobs.pendingBackground)[0]
      if (!background) return yield* Effect.die("Code Mode background marker is unavailable")
      yield* jobs.markBackgroundTerminal(background.notificationID)

      const failed: SessionEvent.CodeMode.Failed[] = []
      yield* bus.project(SessionEvent.CodeMode.Failed, (event) => Effect.sync(() => void failed.push(event)))
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Scope.provide(scope))
      const context = yield* buildRestart(scope, restarted)
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)
      yield* restart.resumeSuspendedSessions
      yield* execution.awaitIdle(sessionID)

      expect(failed).toEqual([])
      expect(yield* executions(sessionID)).toBe(1)
      expect(yield* syntheticMessages(sessionID)).toMatchObject([
        {
          id: background.notificationID,
          text: "Execution failed because the server restarted.",
          metadata: { source: "codemode", executionID, state: "failed" },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])

      yield* restart.resumeSuspendedSessions
      expect(failed).toEqual([])
      expect(yield* executions(sessionID)).toBe(1)
    }),
  )

  it.effect("preserves locally running background work", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_background_existing_parent")
      yield* seedSessions(database, [parent])
      yield* seedBackground(jobs, parent, [{ id: "call-running-shell", shellID: "sh_running", command: "sleep 60" }])

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildRestart(scope)
      const restart = Context.get(context, SessionRestart.Service)
      yield* restart.resumeSuspendedSessions

      expect((yield* store.context(parent)).filter((message) => message.type === "synthetic")).toEqual([])
      expect(yield* jobs.get("call-running-shell")).toMatchObject({ status: "running" })
      expect(yield* jobs.pendingBackground).toHaveLength(1)
    }),
  )

  it.effect("wakes the owner for a silent shell failure persisted before its completion notification", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const sessionID = Session.ID.make("ses_background_completed_shell")
      yield* seedSessions(database, [sessionID])
      const complete = yield* Deferred.make<string>()
      yield* jobs.start({
        id: "call-completed-shell",
        type: "shell",
        recovery: {
          kind: "shell",
          sessionID,
          shellID: "sh_completed",
          command: "exit 7",
        },
        run: Deferred.await(complete),
      })
      yield* jobs.background("call-completed-shell")
      yield* Deferred.succeed(complete, "(no output)\n\nCommand exited with code 7.")
      yield* jobs.wait({ id: "call-completed-shell" })

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildRestart(scope, restarted)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Context.get(context, SessionExecution.Service).awaitIdle(sessionID)

      expect(yield* executions(sessionID)).toBe(1)
      const delivered = yield* syntheticMessages(sessionID)
      expect(delivered).toMatchObject([
        {
          text: '<shell id="call-completed-shell" state="completed" command="exit 7">\n(no output)\n\nCommand exited with code 7.\n</shell>',
        },
      ])
      expect(delivered[0]).toHaveProperty("metadata", {
        source: "shell",
        jobID: "call-completed-shell",
        shellID: "sh_completed",
        state: "completed",
      })
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  for (const delivered of [false, true]) {
    it.effect(`does not duplicate a shell notification already ${delivered ? "delivered" : "admitted"}`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const jobs = yield* Job.Service
        const sessions = yield* Session.Service
        const sessionID = Session.ID.make("ses_shell_notification_retry")
        yield* seedSessions(database, [sessionID])
        yield* seedBackground(jobs, sessionID, [
          { id: "call-shell-notified", shellID: "sh_notified", command: "echo done" },
        ])
        const background = (yield* jobs.pendingBackground)[0]
        if (!background) return yield* Effect.die("background record missing")
        yield* sessions.synthetic({
          id: background.notificationID,
          sessionID,
          text: "Command already completed",
          metadata: { source: "shell", shellID: "sh_notified", state: "completed" },
          resume: false,
        })
        if (delivered) yield* sessions.resume(sessionID)

        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
        const context = yield* buildRestart(scope, restarted)
        yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
        // Recovery's retried notice is the first admission; the wake delivers an undelivered one.
        yield* sessions.wait(sessionID)

        expect(yield* restarted.pendingBackground).toEqual([])
        expect(yield* SessionInbox.list(database.db, sessionID)).toEqual([])
        expect(yield* sessions.messages({ sessionID })).toMatchObject([
          {
            id: background.notificationID,
            type: "synthetic",
            text: "Command already completed",
            metadata: { state: "completed" },
          },
        ])
        expect(yield* sessions.messages({ sessionID })).toHaveLength(1)
      }),
    )
  }

  it.effect("acknowledges recovery markers when their owning session is deleted", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const sessionID = Session.ID.make("ses_background_deleted")
      yield* seedSessions(database, [sessionID])
      yield* seedBackground(jobs, sessionID, [{ id: "call-deleted-shell", shellID: "sh_deleted", command: "sleep 60" }])
      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildRestart(scope, restarted)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions

      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect("delivers a cancelled shell's notice at its owner's next step", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const store = yield* SessionStore.Service
      const parent = Session.ID.make("ses_background_claimed_parent")
      yield* seedSessions(database, [parent])
      yield* seedBackground(jobs, parent, [{ id: "call-claimed-shell", shellID: "sh_claimed", command: "sleep 60" }])

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildRestart(scope, restarted)
      const execution = Context.get(context, SessionExecution.Service)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* execution.awaitIdle(parent)
      expect(
        (yield* store.context(parent)).filter((message) => message.type === "synthetic").map((message) => message.text),
      ).toEqual([expect.stringContaining("Command cancelled because the server restarted")])
      expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
    }),
  )

  it.effect("resumes a background subagent and notifies its parent exactly once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_subagent_recovery_parent")
      const child = Session.ID.make("ses_subagent_recovery_child")
      const unrelated = Session.ID.make("ses_subagent_unrelated_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child, unrelated], { parent_id: parent })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Inspect recovery",
        },
        run: Effect.never,
      })
      yield* jobs.background(child)

      const childStep = steps.hold(child)
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildRestart(scope, restarted)
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)
      yield* restart.resumeSuspendedSessions
      yield* childStep.started

      // A second sweep leaves the child running in its job.
      yield* restart.resumeSuspendedSessions
      expect(yield* executions(child)).toBe(1)
      expect(yield* executions(parent)).toBe(0)
      expect(yield* restarted.get(child)).toMatchObject({ status: "running" })

      yield* childStep.release
      yield* restarted.wait({ id: child })
      yield* awaitDelivered(parent)
      expect(yield* executions(child)).toBe(1)
      expect(yield* executions(parent)).toBe(1)
      expect(yield* syntheticMessages(parent)).toMatchObject([
        {
          description: "Inspect recovery",
          metadata: { source: "subagent", childID: child, agent: "explore", state: "completed" },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
      yield* restart.resumeSuspendedSessions
      yield* execution.awaitIdle(parent)
      expect(yield* syntheticMessages(parent)).toHaveLength(1)
    }),
  )

  it.effect("notifies the parent of a subagent whose execution the stopped process left running", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_subagent_left_running_parent")
      const child = Session.ID.make("ses_subagent_left_running_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Inspect across the restart",
        },
        run: Effect.never,
      })
      yield* jobs.background(child)
      // The process stopped mid-step: the runtime resumes the child's execution from its log at boot, so the
      // child is already active when recovery runs.
      const childStep = yield* steps.busy(child)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Scope.provide(scope))
      const context = yield* buildRestart(scope, restarted)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      // Its job joins the resumed execution rather than starting another.
      expect(yield* restarted.get(child)).toMatchObject({ status: "running" })

      yield* childStep.release
      yield* restarted.wait({ id: child })
      yield* awaitDelivered(parent)
      expect(yield* executions(child)).toBe(1)
      expect(yield* syntheticMessages(parent)).toMatchObject([
        {
          description: "Inspect across the restart",
          metadata: { source: "subagent", childID: child, agent: "explore", state: "completed" },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect("delivers a subagent result persisted before restart without rerunning the child", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_subagent_completed_parent")
      const child = Session.ID.make("ses_subagent_completed_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      const complete = yield* Deferred.make<string>()
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Completed inspection",
        },
        run: Deferred.await(complete),
      })
      yield* jobs.background(child)
      yield* Deferred.succeed(complete, "Recovered result")
      yield* jobs.wait({ id: child })

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildRestart(scope, restarted)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* awaitDelivered(parent)

      expect(yield* executions(child)).toBe(0)
      expect(yield* executions(parent)).toBe(1)
      expect(yield* syntheticMessages(parent)).toMatchObject([
        { text: expect.stringContaining("Recovered result"), metadata: { state: "completed" } },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect("retains a subagent completion marker when synthetic admission conflicts", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const admission = yield* SessionInbox.Service
      const jobs = yield* Job.Service
      const sessions = yield* Session.Service
      const parent = Session.ID.make("ses_completion_conflict_parent")
      const child = Session.ID.make("ses_completion_conflict_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Completed inspection",
        },
        run: Effect.succeed("Recovered result"),
      })
      yield* jobs.wait({ id: child })
      yield* jobs.background(child)
      const marker = (yield* jobs.pendingBackground)[0]
      if (!marker) return yield* Effect.die("background record missing")
      // Held, so it stays pending.
      yield* admission.admit({
        id: marker.notificationID,
        sessionID: parent,
        resume: false,
        item: { type: "user", payload: { text: "User input" }, delivery: "steer" },
      })

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildRestart(scope)
      const exit = yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.SyntheticConflictError)
      // The admission did not wake the parent.
      expect(yield* executions(parent)).toBe(0)
      expect(yield* jobs.pendingBackground).toEqual([marker])
      expect(yield* sessions.inbox(parent)).toMatchObject([{ type: "user", payload: { text: "User input" } }])
    }),
  )
})

function seedBackground(
  jobs: Job.Interface,
  sessionID: Session.ID,
  background: ReadonlyArray<{ readonly id: string; readonly shellID: string; readonly command: string }>,
) {
  return Effect.forEach(
    background,
    (job) =>
      Effect.gen(function* () {
        yield* jobs.start({
          id: job.id,
          type: "shell",
          recovery: { kind: "shell", sessionID, shellID: job.shellID, command: job.command },
          run: Effect.never,
        })
        yield* jobs.background(job.id)
      }),
    { discard: true },
  )
}

function seedSessions(
  database: Database.Service["Service"],
  sessionIDs: ReadonlyArray<Session.ID>,
  values: Partial<Pick<typeof SessionTable.$inferInsert, "parent_id">> = {},
) {
  return Effect.gen(function* () {
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values(
        sessionIDs.map((id) => ({
          id,
          project_id: Project.ID.global,
          slug: id,
          directory: "/project",
          title: id,
          version: "test",
          ...values,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

/** Executions the runtime started for a Session, counted from its log. */
function executions(sessionID: Session.ID) {
  return Recorded.events(
    and(eq(EventTable.aggregate_id, sessionID), eq(SpecterEventTable.type, SessionEvent.Execution.Started.type)),
  ).pipe(Effect.map((rows) => rows.length))
}

/** The synthetic input a Session's history holds. */
function syntheticMessages(sessionID: Session.ID) {
  return SessionStore.Service.use((store) => store.context(sessionID)).pipe(
    Effect.map((messages) => messages.filter((message) => message.type === "synthetic")),
  )
}

/** Resolves once recovery's notice started an execution of the Session and it settled. */
function awaitDelivered(sessionID: Session.ID) {
  return Effect.gen(function* () {
    const execution = yield* SessionExecution.Service
    while ((yield* executions(sessionID)) === 0)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
    yield* execution.awaitIdle(sessionID)
  })
}

/** The restart actions over the test harness's Session and runtime, with the given (restarted) jobs. */
function buildRestart(scope: Scope.Closeable, overrideJobs?: Job.Interface) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const jobs = overrideJobs ?? (yield* Job.Service)
    const sessions = yield* Session.Service
    const execution = yield* SessionExecution.Service
    const codemode = yield* CodeModeStore.Service
    const locations = Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(
        () =>
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          Layer.empty as unknown as Layer.Layer<LocationServices>,
      ),
    )
    return yield* Layer.buildWithScope(
      SessionRestart.layer.pipe(
        Layer.provideMerge(Layer.succeed(Session.Service, sessions)),
        Layer.provideMerge(Layer.succeed(SessionExecution.Service, execution)),
        Layer.provide(ExternalAgentSession.layer),
        Layer.provide(CodeModeResume.layer),
        Layer.provide(Layer.succeed(CodeModeStore.Service, codemode)),
        Layer.provide(Layer.succeed(Database.Service, database)),
        Layer.provide(Layer.succeed(Bus.Service, bus)),
        Layer.provide(Layer.succeed(SessionStore.Service, store)),
        Layer.provide(Layer.succeed(Job.Service, jobs)),
        Layer.provide(locations),
      ),
      scope,
    )
  })
}
