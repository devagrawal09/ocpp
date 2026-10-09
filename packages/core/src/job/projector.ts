export * as JobProjector from "./projector.js"

import { SessionEvent } from "@ocpp/schema/session-event"
import { SessionFact } from "@ocpp/schema/session-fact"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { JobBackgroundTable } from "./sql.js"

/** Background job markers are projections of their facts in Specter's Event Log. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    const terminal = (executionID: string) =>
      db
        .update(JobBackgroundTable)
        .set({ terminal: true })
        .where(eq(JobBackgroundTable.job_id, executionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid)

    yield* bus.project(SessionFact.BackgroundRecorded, (event) => {
      const row = {
        job_id: event.data.jobID,
        recovery: event.data.recovery,
        status: event.data.status,
        output: event.data.output ?? null,
        error: event.data.error ?? null,
      }
      return db
        .insert(JobBackgroundTable)
        .values({ notification_id: event.data.notificationID, ...row })
        .onConflictDoUpdate({ target: JobBackgroundTable.notification_id, set: row })
        .run()
        .pipe(Effect.orDie, Effect.asVoid)
    })
    yield* bus.project(SessionFact.BackgroundTerminal, (event) =>
      db
        .update(JobBackgroundTable)
        .set({ terminal: true })
        .where(eq(JobBackgroundTable.notification_id, event.data.notificationID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* bus.project(SessionFact.BackgroundCompleted, (event) =>
      db
        .delete(JobBackgroundTable)
        .where(eq(JobBackgroundTable.notification_id, event.data.notificationID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    // A Code Mode run's outcome reaching its Session is what makes its background job terminal.
    yield* bus.project(SessionEvent.CodeMode.Completed, (event) => terminal(event.data.executionID))
    yield* bus.project(SessionEvent.CodeMode.Failed, (event) => terminal(event.data.executionID))
  }),
)

export const node = makeGlobalNode({ name: "job-projector", layer, deps: [Bus.node, Database.node] })
