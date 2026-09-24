import { describe, expect } from "bun:test"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      [Bus.node, Bus.configured({ persist: true })],
      [Project.node, globalProjectNode],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
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

      yield* bus.publish(SessionEvent.Execution.Failed, {
        sessionID: created.id,
        error: { type: "provider.transport", message: "socket closed" },
      })
      expect(yield* row()).toEqual({ outcome: "failed", type: "provider.transport", message: "socket closed" })

      // A later success describes the outcome recorded at time_idle, so the stale error goes away.
      yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: created.id })
      expect(yield* row()).toEqual({ outcome: "succeeded", type: null, message: null })

      yield* bus.publish(SessionEvent.Execution.Failed, {
        sessionID: created.id,
        error: { type: "unknown", message: "again" },
      })
      // Shutdown interruption is not a terminal outcome, so it leaves the recorded failure alone.
      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID: created.id, reason: "shutdown" })
      expect(yield* row()).toEqual({ outcome: "failed", type: "unknown", message: "again" })

      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID: created.id, reason: "user" })
      expect(yield* row()).toEqual({ outcome: "interrupted", type: null, message: null })
    }),
  )
})
