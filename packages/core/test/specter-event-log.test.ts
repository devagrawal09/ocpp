import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { EventLogFailure, SpecterVersionConflictError } from "@ocpp/runtime"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { SpecterEventLog } from "@ocpp/core/specter/event-log"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node]), []))

// Specter's Event Log on OC++'s database, without the Bus's projections.
const makeLog = Effect.gen(function* () {
  const database = yield* Database.Service
  let next = 0
  return SpecterEventLog.make(database.db, {
    drafts: (_, count) => Array.from({ length: count }, () => ({ id: `evt_${++next}` })),
    appended: () => Effect.succeed(Effect.void),
  })
})

const stale = (exit: Exit.Exit<unknown, EventLogFailure>) =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      reason.error.operation === "append" &&
      reason.error.cause instanceof SpecterVersionConflictError,
  )

describe("Specter Event Log", () => {
  it.effect("appends unless a fact the decision read landed after it read", () =>
    Effect.gen(function* () {
      const log = yield* makeLog
      yield* log.append([
        { type: "kv-stored", payload: { key: "a", value: "1" } },
        { type: "kv-removed", payload: { key: "b" } },
      ])
      const read = { afterOrder: 1, eventTypes: ["kv-removed"] }
      // A later fact of a type the decision read makes the append stale; one of another type does not.
      expect(
        stale(
          yield* Effect.exit(log.append([{ type: "kv-stored", payload: { key: "b" } }], { expectedUnchanged: read })),
        ),
      ).toBe(true)
      const other = yield* log.append([{ type: "kv-stored", payload: { key: "c", value: "3" } }], {
        expectedUnchanged: { afterOrder: 1, eventTypes: ["session-created"] },
      })
      expect(other.version).toBe(3)
      // `matches` narrows the facts that conflict, as consistency keys do.
      const narrowed = yield* log.append([{ type: "kv-stored", payload: { key: "b", value: "4" } }], {
        expectedUnchanged: { ...read, matches: (event) => (event.payload as { key: string }).key === "a" },
      })
      expect(narrowed.version).toBe(4)
      expect(
        stale(
          yield* Effect.exit(
            log.append([{ type: "kv-removed", payload: { key: "b" } }], {
              expectedUnchanged: { ...read, matches: (event) => (event.payload as { key: string }).key === "b" },
            }),
          ),
        ),
      ).toBe(true)
      expect(yield* log.currentVersion).toBe(4)
    }),
  )

  it.effect("answers a known idempotency key before its consistency check", () =>
    Effect.gen(function* () {
      const log = yield* makeLog
      const first = yield* log.append([{ type: "kv-stored", payload: { key: "a", value: "1" } }], {
        idempotencyKey: "dispatch-1",
      })
      const again = yield* log.append([{ type: "kv-stored", payload: { key: "a", value: "2" } }], {
        idempotencyKey: "dispatch-1",
        expectedUnchanged: { afterOrder: 0, eventTypes: ["kv-stored"] },
      })
      expect(again).toMatchObject({ duplicate: true, version: first.version })
    }),
  )
})
