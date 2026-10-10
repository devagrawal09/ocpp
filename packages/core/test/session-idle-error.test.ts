import { describe, expect } from "bun:test"
import { Bus } from "@ocpp/core/bus"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Location } from "@ocpp/core/location"
import { Project } from "@ocpp/core/project"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionTable } from "@ocpp/core/session/sql"
import { SessionStore } from "@ocpp/core/session/store"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { TestStepHost } from "./fixture/step-host"

const steps = TestStepHost.make()
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [[Bus.node, Bus.configured()], [Project.node, globalProjectNode], steps.replacement],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("session idle error projection", () => {
  it.effect("keeps the failure behind a failed outcome and clears it on the next terminal", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      const row = () =>
        db
          .select({
            outcome: SessionTable.idle_outcome,
            type: SessionTable.idle_error_type,
            message: SessionTable.idle_error_message,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, created.id))
          .get()

      yield* bus.publish(SessionEvent.Execution.Settled, {
        sessionID: created.id,
        error: { type: "provider.transport", message: "socket closed" },
        outcome: "failed",
      })
      expect(yield* row()).toEqual({ outcome: "failed", type: "provider.transport", message: "socket closed" })

      // A later success describes the outcome recorded at time_idle, so the stale error goes away.
      yield* bus.publish(SessionEvent.Execution.Settled, { sessionID: created.id, outcome: "succeeded" })
      expect(yield* row()).toEqual({ outcome: "succeeded", type: null, message: null })

      yield* bus.publish(SessionEvent.Execution.Settled, {
        sessionID: created.id,
        error: { type: "unknown", message: "again" },
        outcome: "failed",
      })
      // Shutdown interruption is not a terminal outcome, so it leaves the recorded failure alone.
      yield* bus.publish(SessionEvent.Execution.Settled, {
        sessionID: created.id,
        reason: "shutdown",
        outcome: "interrupted",
      })
      expect(yield* row()).toEqual({ outcome: "failed", type: "unknown", message: "again" })

      yield* bus.publish(SessionEvent.Execution.Settled, {
        sessionID: created.id,
        reason: "user",
        outcome: "interrupted",
      })
      expect(yield* row()).toEqual({ outcome: "interrupted", type: null, message: null })
    }),
  )
})
