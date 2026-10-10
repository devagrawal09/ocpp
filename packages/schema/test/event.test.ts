import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Event } from "../src/event.js"
import { EventLog } from "../src/event-log.js"

describe("public event schemas", () => {
  test("definition is pure", () => {
    const definitions = Event.inventory()
    Event.ephemeral({ type: "test.pure", schema: { value: Schema.String } })
    expect(definitions).toEqual([])
  })

  test("one type names one definition", () => {
    const definition = Event.durable({
      type: "test.typed",
      durable: { aggregate: "id" },
      schema: { id: Schema.String },
    })
    const reshaped = Event.durable({
      type: "test.typed",
      durable: { aggregate: "id" },
      schema: { id: Schema.String, value: Schema.String },
    })

    expect(Event.byType([definition, definition]).get(definition.type)).toBe(definition)
    expect(() => Event.byType([definition, reshaped])).toThrow("Duplicate event definition for test.typed")
  })

  test("durable definitions are indexed by type, and their envelope carries no version", () => {
    const definition = Event.durable({
      type: "test.durable",
      durable: { aggregate: "id" },
      schema: { id: Schema.String },
    })

    expect(Event.durableMap([definition]).get("test.durable")).toBe(definition)
    expect(
      Schema.encodeSync(definition)({
        id: Event.ID.make("evt_test"),
        created: 1,
        type: "test.durable",
        durable: { aggregateID: "id_test", seq: Event.Seq.make(0) },
        data: { id: "id_test" },
      }).durable,
    ).toEqual({ aggregateID: "id_test", seq: 0 })
  })

  test("synced marker encodes the captured watermark", () => {
    expect(
      Schema.encodeSync(EventLog.Synced)({
        type: "log-synced",
        aggregateID: "ses_test",
        seq: Event.Seq.make(1),
      }),
    ).toEqual({ type: "log-synced", aggregateID: "ses_test", seq: 1 })
    expect(Schema.encodeSync(EventLog.Synced)({ type: "log-synced", aggregateID: "ses_test" })).toEqual({
      type: "log-synced",
      aggregateID: "ses_test",
    })
  })
})
