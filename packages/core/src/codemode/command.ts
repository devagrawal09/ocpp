export * as CodeModeCommand from "./command.js"

import { CodeModeCommand } from "@ocpp/schema/codemode-command"
import { Command } from "@ocpp/schema/command"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionFact } from "@ocpp/schema/session-fact"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import type { SessionSchema } from "../session/schema.js"
import { CodeModeCommandTable } from "./command.sql.js"
import { CodeModeHandler } from "./handler.js"

export const Info = CodeModeCommand.Info
export type Info = CodeModeCommand.Info

export class DefinitionError extends Schema.TaggedError<DefinitionError>()("CodeModeCommand.DefinitionError", {
  message: Schema.String,
}) {}

export interface Interface {
  /** Defines or replaces a Session command. */
  readonly define: (sessionID: SessionSchema.ID, input: Info) => Effect.Effect<Info, DefinitionError>
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly get: (sessionID: SessionSchema.ID, name: string) => Effect.Effect<Info | undefined>
  readonly remove: (sessionID: SessionSchema.ID, name: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/CodeModeCommand") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    // A Session's commands are the projection of their facts in Specter's Event Log.
    yield* bus.project(SessionFact.CommandDefined, (event) =>
      db
        .insert(CodeModeCommandTable)
        .values({
          session_id: event.data.sessionID,
          name: event.data.name,
          description: event.data.description,
          handler: event.data.handler,
          time_created: event.created,
          time_updated: event.created,
        })
        .onConflictDoUpdate({
          target: [CodeModeCommandTable.session_id, CodeModeCommandTable.name],
          set: { description: event.data.description, handler: event.data.handler, time_updated: event.created },
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* bus.project(SessionFact.CommandRemoved, (event) =>
      db
        .delete(CodeModeCommandTable)
        .where(
          and(
            eq(CodeModeCommandTable.session_id, event.data.sessionID),
            eq(CodeModeCommandTable.name, event.data.name),
          ),
        )
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    const columns = {
      name: CodeModeCommandTable.name,
      description: CodeModeCommandTable.description,
      handler: CodeModeCommandTable.handler,
    }

    return Service.of({
      define: Effect.fn("CodeModeCommand.define")(function* (sessionID, input) {
        const problem =
          CodeModeHandler.nameProblem(input.name) ??
          (Command.Builtin.some((name) => name === input.name)
            ? `/${input.name} is a built-in command of the app. Choose another name.`
            : undefined) ??
          (yield* CodeModeHandler.problem(db, sessionID, input.handler, true))
        if (problem) return yield* new DefinitionError({ message: problem })
        yield* bus.publish(SessionFact.CommandDefined, {
          sessionID,
          name: input.name,
          description: input.description,
          handler: input.handler,
        })
        return Info.make(input)
      }),
      list: Effect.fn("CodeModeCommand.list")((sessionID) =>
        db
          .select(columns)
          .from(CodeModeCommandTable)
          .where(eq(CodeModeCommandTable.session_id, sessionID))
          .orderBy(asc(CodeModeCommandTable.name))
          .all()
          .pipe(Effect.orDie),
      ),
      get: Effect.fn("CodeModeCommand.get")((sessionID, name) =>
        db
          .select(columns)
          .from(CodeModeCommandTable)
          .where(and(eq(CodeModeCommandTable.session_id, sessionID), eq(CodeModeCommandTable.name, name)))
          .get()
          .pipe(Effect.orDie),
      ),
      remove: Effect.fn("CodeModeCommand.remove")(function* (sessionID, name) {
        const stored = yield* db
          .select({ name: CodeModeCommandTable.name })
          .from(CodeModeCommandTable)
          .where(and(eq(CodeModeCommandTable.session_id, sessionID), eq(CodeModeCommandTable.name, name)))
          .get()
          .pipe(Effect.orDie)
        if (!stored) return false
        yield* bus.publish(SessionFact.CommandRemoved, { sessionID, name })
        return true
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })
