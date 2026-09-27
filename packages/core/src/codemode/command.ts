export * as CodeModeCommand from "./command.js"

import { CodeModeCommand } from "@ocpp/schema/codemode-command"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
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
    const columns = {
      name: CodeModeCommandTable.name,
      description: CodeModeCommandTable.description,
      handler: CodeModeCommandTable.handler,
    }

    return Service.of({
      define: Effect.fn("CodeModeCommand.define")(function* (sessionID, input) {
        const problem =
          CodeModeHandler.nameProblem(input.name) ??
          (yield* CodeModeHandler.problem(db, sessionID, input.handler, true))
        if (problem) return yield* new DefinitionError({ message: problem })
        yield* db
          .insert(CodeModeCommandTable)
          .values({ session_id: sessionID, name: input.name, description: input.description, handler: input.handler })
          .onConflictDoUpdate({
            target: [CodeModeCommandTable.session_id, CodeModeCommandTable.name],
            set: { description: input.description, handler: input.handler, time_updated: Date.now() },
          })
          .run()
          .pipe(Effect.orDie)
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
        const removed = yield* db
          .delete(CodeModeCommandTable)
          .where(and(eq(CodeModeCommandTable.session_id, sessionID), eq(CodeModeCommandTable.name, name)))
          .returning({ name: CodeModeCommandTable.name })
          .get()
          .pipe(Effect.orDie)
        return removed !== undefined
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
