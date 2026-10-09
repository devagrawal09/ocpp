import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Bus } from "@ocpp/core/bus"
import { Agent } from "@ocpp/core/agent"
import { CodeModeExecution } from "@ocpp/schema/codemode-execution"
import { EventTable } from "@ocpp/core/event/sql"
import { Model } from "@ocpp/core/model"
import { Project } from "@ocpp/core/project"
import { ProjectTable } from "@ocpp/core/project/sql"
import { Provider } from "@ocpp/core/provider"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionTable, SessionMessageTable } from "@ocpp/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node]), [
    [Bus.node, Bus.configured()],
  ]),
)
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }

const content = (text: string) => [{ type: "text" as const, text }] as const

describe("Session tool progress", () => {
  it.effect("keeps progress live-only and terminal settlements durable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* Bus.Service
      const sessionID = Session.ID.make("ses_tool_progress_projector")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "progress",
          directory: "/project",
          title: "progress",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const assistantMessageID = SessionMessage.ID.create()
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model,
      })
      const readAssistant = Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, assistantMessageID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* Effect.die("Missing projected assistant")
        return Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
      })
      const start = (id: string, name = "bash") =>
        Effect.gen(function* () {
          yield* service.publish(SessionEvent.Tool.Input.Started, {
            sessionID,
            assistantMessageID,
            id,
            name,
          })
          yield* service.publish(SessionEvent.Tool.Called, {
            sessionID,
            assistantMessageID,
            id,
            input: { command: "pwd" },
            executed: false,
          })
        })

      yield* start("call-success")
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", metadata: {} },
      })

      const progress = yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        assistantMessageID,
        id: "call-success",
        metadata: { phase: "checkpoint" },
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", metadata: {} },
      })

      const success = yield* service.publish(SessionEvent.Tool.Success, {
        sessionID,
        assistantMessageID,
        id: "call-success",
        metadata: { phase: "done" },
        content: content("complete"),
        executed: false,
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "completed", metadata: { phase: "done" }, content: content("complete") },
      })

      yield* start("call-codemode", "execute")
      const executionID = CodeModeExecution.ID.create()
      yield* service.publish(SessionEvent.CodeMode.Started, {
        sessionID,
        assistantMessageID,
        id: "call-codemode",
        executionID,
      })
      const codeProgress = yield* service.publish(SessionEvent.CodeMode.Progress, {
        sessionID,
        assistantMessageID,
        id: "call-codemode",
        executionID,
        events: [{ type: "trace", kind: "return", value: "1" }],
      })
      const codeCompleted = yield* service.publish(SessionEvent.CodeMode.Completed, {
        sessionID,
        assistantMessageID,
        id: "call-codemode",
        executionID,
        events: [{ type: "trace", kind: "return", value: "1" }],
      })
      yield* service.publish(SessionEvent.Tool.Success, {
        sessionID,
        assistantMessageID,
        id: "call-codemode",
        metadata: { executionStatus: "running", events: [] },
        content: content("Execution started"),
        executed: false,
      })
      expect((yield* readAssistant).content[1]).toMatchObject({
        state: {
          status: "completed",
          metadata: {
            executionID,
            executionStatus: "completed",
            events: [{ type: "trace", kind: "return", value: "1" }],
          },
        },
      })
      expect(Schema.is(SessionEvent.Durable)(codeProgress)).toBe(false)
      expect(Schema.is(SessionEvent.Durable)(codeCompleted)).toBe(true)

      yield* start("call-failed")
      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        assistantMessageID,
        id: "call-failed",
        metadata: { phase: "checkpoint" },
      })
      const failed = yield* service.publish(SessionEvent.Tool.Failed, {
        sessionID,
        assistantMessageID,
        id: "call-failed",
        error: { type: "unknown", message: "boom" },
        metadata: { phase: "checkpoint" },
        content: content("before failure"),
        executed: false,
      })
      expect((yield* readAssistant).content[2]).toMatchObject({
        state: {
          status: "error",
          metadata: { phase: "checkpoint" },
          content: content("before failure"),
          error: { type: "unknown", message: "boom" },
        },
      })
      expect(Schema.is(SessionEvent.Durable)(progress)).toBe(false)
      expect(Schema.is(SessionEvent.Durable)(success)).toBe(true)
      expect(Schema.is(SessionEvent.Durable)(failed)).toBe(true)

      const rows = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => row.type)).not.toContain(Bus.versionedType(SessionEvent.Tool.Progress.type, 1))
      expect(rows.map((row) => row.type)).toContain(Bus.versionedType(SessionEvent.Tool.Success.type, 2))
      expect(rows.map((row) => row.type)).toContain(Bus.versionedType(SessionEvent.Tool.Failed.type, 2))
    }),
  )
})
