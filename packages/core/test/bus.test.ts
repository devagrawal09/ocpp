import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Stream } from "effect"
import { Bus } from "@ocpp/core/bus"
import { Event } from "@ocpp/schema/event"
import { Session } from "@ocpp/schema/session"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { EventSequenceTable, EventTable } from "@ocpp/core/event/sql"
import { SpecterEventTable } from "@ocpp/core/specter/sql"
import { ProjectFact } from "@ocpp/schema/project-fact"
import { Project } from "@ocpp/core/project"
import { KeyValueFact } from "@ocpp/schema/key-value-fact"
import { Credential } from "@ocpp/schema/credential"
import { Integration } from "@ocpp/schema/integration"
import { Location } from "@ocpp/core/location"
import { AbsolutePath } from "@ocpp/core/schema"
import { Workspace } from "@ocpp/core/workspace"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { recordSession } from "./fixture/session"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location({ directory: AbsolutePath.make("project"), workspaceID: Workspace.ID.make("wrk_test") }),
  ),
)
const Message = Bus.ephemeral({
  type: "test.message",
  schema: {
    text: Schema.String,
  },
})

// Durable events are facts a runtime Command records in Specter's log; the tests store values through
// storeValue, each in the aggregate of its key.
const SyncMessage = KeyValueFact.Stored

/** Not in the inventory. */
const Uninventoried = Bus.durable({
  type: "test.uninventoried",
  durable: { aggregate: "id" },
  schema: { id: Schema.String },
})
const GlobalMessage = Bus.ephemeral({
  type: "test.global",
  schema: {
    text: Schema.String,
  },
})
const CountMessage = Bus.ephemeral({
  type: "test.count",
  schema: {
    count: Schema.Number,
  },
})

const DurableMessage = KeyValueFact.Stored
const durableData = (key: string, text: string) => ({ key, value: text })

/** Stores a value through the runtime's storeValue, with the options of its fact: the event it records. */
const store = (bus: Bus.Interface, data: { readonly key: string; readonly value: string }, options?: Bus.FactOptions) =>
  bus.command({ type: "storeValue", payload: data }, options ? { facts: [options] } : undefined).pipe(
    Effect.orDie,
    Effect.map((events) => events[0] as Event.Payload<typeof KeyValueFact.Stored>),
  )

/** Records a project's directories in one commit, as a refresh that found them does: one fact per directory. */
const refresh = (bus: Bus.Interface, projectID: string, directories: ReadonlyArray<string>) =>
  bus
    .command({
      type: "refreshWorktrees",
      payload: {
        projectID: Project.ID.make(projectID),
        found: directories.map((directory) => ({ directory: AbsolutePath.make(directory) })),
        gone: [],
      },
    })
    .pipe(Effect.orDie)

const createProject = (bus: Bus.Interface, projectID: string) =>
  bus
    .command({
      type: "resolveProject",
      payload: { projectID: Project.ID.make(projectID), canonical: AbsolutePath.make("/repo") },
    })
    .pipe(Effect.orDie)

/** Followed log read without markers: the old `durable` stream shape. */
const tail = (bus: Bus.Interface, input: { aggregateID: string; after?: number }) =>
  bus.log({ ...input, follow: true }).pipe(Stream.filter((item): item is Event.Payload => !Bus.isSynced(item)))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Location.node]), [
    [Location.node, locationLayer],
    [Bus.node, Bus.configured()],
  ]),
)
const itWithoutLocation = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node]), [[Bus.node, Bus.configured()]]),
)

describe("Bus", () => {
  it.effect("subscribes to multiple event definitions with a discriminated payload union", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      // @ts-expect-error multi-definition subscriptions require at least one definition
      bus.subscribe([])
      const fiber = yield* bus
        .subscribe([Message, CountMessage])
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* bus.publish(Message, { text: "hello" })
      yield* bus.publish(CountMessage, { count: 2 })

      const received = (yield* Fiber.join(fiber)).map((event) =>
        event.type === "test.message" ? event.data.text : event.data.count,
      )
      expect(received).toEqual(["hello", 2])
    }),
  )

  it.effect("publishes events with the current location", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const fiber = yield* bus.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* bus.publish(Message, { text: "hello" })
      const received = yield* Fiber.join(fiber)

      expect(received).toEqual([event])
      expect(event.type).toBe("test.message")
      expect(event).not.toHaveProperty("version")
      expect(event.data).toEqual({ text: "hello" })
      expect(event.location).toEqual({
        directory: AbsolutePath.make("project"),
        workspaceID: Workspace.ID.make("wrk_test"),
      })
    }),
  )

  it.effect("omits ambient and explicit locations for global events", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const event = yield* bus.publish(
        GlobalMessage,
        { text: "hello" },
        {
          global: true,
          location: { directory: AbsolutePath.make("explicit"), workspaceID: Workspace.ID.make("wrk_explicit") },
        },
      )

      expect(event).not.toHaveProperty("location")
      expect(event.type).toBe("test.global")
    }),
  )

  itWithoutLocation.effect("omits location when no location is available", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const event = yield* bus.publish(GlobalMessage, { text: "hello" })

      expect(event).not.toHaveProperty("location")
      expect(event.type).toBe("test.global")
    }),
  )

  it.effect("dispatches a runtime Command, each fact with the options at its position", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const sessionID = Session.ID.create()
      yield* recordSession({ id: sessionID, directory: "/project" })
      const id = Event.ID.create()
      const committed: number[] = []
      const [renamed] = yield* bus.command(
        { type: "renameSession", payload: { sessionID, title: "Dispatched" } },
        {
          facts: [
            {
              id,
              metadata: { source: "test" },
              commit: (seq) =>
                Effect.sync(() => {
                  committed.push(seq)
                }),
            },
          ],
        },
      )

      // The dispatch's time, from the test clock, and the ambient Location.
      expect(renamed).toMatchObject({
        id,
        created: 0,
        type: "session-renamed",
        metadata: { source: "test" },
        location: { directory: "project", workspaceID: "wrk_test" },
        durable: { aggregateID: sessionID, seq: 1 },
        data: { sessionID, title: "Dispatched" },
      })
      expect(committed).toEqual([1])
    }),
  )

  it.effect("fails a dispatch with the Command's rejection", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const error = yield* Effect.flip(
        bus.command({ type: "renameSession", payload: { sessionID: Session.ID.create(), title: "Missing" } }),
      )

      expect(error.cause).toEqual(new Error("Session not found"))
    }),
  )

  it.effect("records no test history through a production Bus", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const exit = yield* bus
        .command({
          type: "recordHistory",
          payload: { facts: [{ type: "kv-stored", payload: { key: "history", value: "refused" } }] },
        } as unknown as Bus.RuntimeCommand)
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    }),
  )

  it.effect("places a durable event in its aggregate, with no version", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const key = Session.ID.create()
      const event = yield* store(bus, { key, value: "Placed" })

      expect(event.type).toBe("kv-stored")
      expect(event.durable).toEqual({ aggregateID: key, seq: Event.Seq.make(0) })
    }),
  )

  it.effect("publishes to typed and wildcard subscriptions", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const typed = yield* bus.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const wildcard = yield* bus.subscribe().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* bus.publish(Message, { text: "hello" })

      expect(yield* Fiber.join(typed)).toEqual([event])
      expect(yield* Fiber.join(wildcard)).toEqual([event])
    }),
  )

  it.effect("runs projectors inline", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const received = new Array<Event.Payload>()
      yield* bus.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      const event = yield* store(bus, { key: "one", value: "hello" })
      yield* store(bus, { key: "one", value: "second event" })

      expect(received[0]).toEqual(event)
      expect(received[1]?.data).toEqual({ key: "one", value: "second event" })
    }),
  )

  it.effect("commits local operational state inside a new durable event transaction", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const received = new Array<string>()
      const aggregateID = Event.ID.create()
      yield* bus.project(SyncMessage, () => Effect.sync(() => received.push("projector")))

      yield* store(
        bus,
        { key: aggregateID, value: "hello" },
        { commit: (seq) => Effect.sync(() => received.push(`commit:${seq}`)) },
      )

      expect(received).toEqual(["projector", "commit:0"])
    }),
  )

  it.effect("rolls back the durable event and projector when the local commit fails", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const aggregateID = Event.ID.create()
      yield* db.run("CREATE TABLE IF NOT EXISTS event_commit_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_commit_probe")
      yield* bus.project(SyncMessage, () =>
        db.run("INSERT INTO event_commit_probe (value) VALUES ('projected')").pipe(Effect.orDie, Effect.asVoid),
      )

      const exit = yield* store(
        bus,
        { key: aggregateID, value: "hello" },
        { commit: () => Effect.die("commit failed") },
      ).pipe(Effect.exit)

      expect(String(exit)).toContain("commit failed")
      expect(yield* db.all("SELECT value FROM event_commit_probe")).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
    }),
  )

  it.effect("numbers each durable event's fact in its aggregate; Specter's log holds the event", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const aggregateID = Event.ID.create()

      const event = yield* store(bus, { key: aggregateID, value: "hello" })

      const indexed = yield* db
        .select({ seq: EventTable.seq, fact: SpecterEventTable })
        .from(EventTable)
        .innerJoin(SpecterEventTable, eq(SpecterEventTable.order, EventTable.log_order))
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      expect(indexed).toEqual([
        {
          seq: 0,
          fact: expect.objectContaining({
            id: event.id,
            type: "kv-stored",
            payload: { key: aggregateID, value: "hello" },
            // The fact keeps the time its publisher gave the event.
            recorded_at: new Date(event.created).toISOString(),
          }),
        },
      ])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([{ aggregate_id: aggregateID, seq: 0 }])
    }),
  )
  it.effect("refuses to publish a durable event: only a runtime Command records a fact", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const key = Session.ID.create()

      const stored = yield* bus.publish(KeyValueFact.Stored, { key, value: "Published" }).pipe(Effect.exit)
      const uninventoried = yield* bus.publish(Uninventoried, { id: key }).pipe(Effect.exit)

      expect(String(stored)).toContain("kv-stored is a durable fact, which only a runtime Command records")
      expect(String(uninventoried)).toContain("test.uninventoried is a durable fact")
      expect(yield* Stream.runCollect(bus.log({ aggregateID: key }))).toEqual([
        { type: "log-synced", aggregateID: key },
      ])
    }),
  )

  it.effect("runs projectors before publishing to streams", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const received = new Array<string>()
      const fiber = yield* bus.subscribe().pipe(
        Stream.take(1),
        Stream.runForEach(() => Effect.sync(() => received.push("stream"))),
        Effect.forkScoped,
      )
      yield* bus.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      yield* Effect.yieldNow
      yield* store(bus, { key: "one", value: "hello" })
      yield* Fiber.join(fiber)

      expect(received).toEqual([SyncMessage.type, "stream"])
    }),
  )

  it.effect("runs listeners inline after projectors", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const received = new Array<string>()
      yield* bus.project(SyncMessage, () =>
        Effect.sync(() => {
          received.push("projector")
        }),
      )
      const unsubscribe = yield* bus.listen(() =>
        Effect.sync(() => {
          received.push("listener")
        }),
      )

      yield* store(bus, { key: "one", value: "hello" })
      yield* unsubscribe
      yield* store(bus, { key: "one", value: "after unsubscribe" })

      expect(received).toEqual(["projector", "listener", "projector"])
    }),
  )

  it.effect("isolates observer defects after durable events commit", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const received = new Array<string>()
      yield* bus.listen(() => {
        throw new Error("listener defect")
      })
      yield* bus.listen((event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      const event = yield* store(bus, { key: "one", value: "hello" })

      expect(received).toEqual([SyncMessage.type])
      expect(event.durable?.seq).toBeNumber()
    }),
  )

  it.effect("notifies global listeners only after a durable event is committed", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const aggregateID = Event.ID.create()
      const observed = new Array<{ id: string; seq: number }>()
      yield* bus.listen((event) =>
        event.type !== SyncMessage.type
          ? Effect.void
          : db
              .select({ id: SpecterEventTable.id, seq: EventTable.seq })
              .from(EventTable)
              .innerJoin(SpecterEventTable, eq(SpecterEventTable.order, EventTable.log_order))
              .where(eq(SpecterEventTable.id, event.id))
              .get()
              .pipe(
                Effect.orDie,
                Effect.tap((row) =>
                  Effect.sync(() => {
                    if (row) observed.push(row)
                  }),
                ),
                Effect.asVoid,
              ),
      )

      const event = yield* store(bus, { key: aggregateID, value: "committed" })
      if (!event.durable) throw new Error("Expected durable event metadata")

      expect(observed).toEqual([{ id: event.id, seq: event.durable.seq }])
    }),
  )

  it.effect("preserves observer interruption", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      yield* bus.listen(() => Effect.interrupt)

      const exit = yield* store(bus, { key: "interrupted", value: "hello" }).pipe(Effect.exit)
      const committed = yield* db
        .select({ order: EventTable.log_order })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, "interrupted"))
        .get()
        .pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBeTrue()
      expect(committed).toBeDefined()
    }),
  )

  it.effect("keeps live-only listener defects fail-fast", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const defect = new Error("listener defect")
      yield* bus.listen(() => Effect.die(defect))

      expect(yield* bus.publish(Message, { text: "hello" }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("inserts durable event rows on a dispatch", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const aggregateID = Event.ID.create()

      const event = yield* store(bus, { key: aggregateID, value: "first" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
      expect(rows[0]?.seq).toBe(event.durable.seq)
    }),
  )

  it.effect("increments durable event seq per aggregate", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const aggregateID = Event.ID.create()

      yield* store(bus, { key: aggregateID, value: "first" })
      yield* store(bus, { key: aggregateID, value: "second" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
    }),
  )

  it.effect("records a Command's facts of one aggregate atomically, in the order it records them", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const aggregateID = Event.ID.create()
      yield* createProject(bus, aggregateID)
      const observed = new Array<string>()
      yield* bus.project(ProjectFact.WorktreeRecorded, (event) =>
        Effect.sync(() => {
          observed.push(`project:${event.data.directory}`)
        }),
      )
      yield* bus.listen((event) =>
        event.type === ProjectFact.WorktreeRecorded.type
          ? Effect.gen(function* () {
              const directory = (event.data as { readonly directory: string }).directory
              const row = yield* db
                .select({ seq: EventSequenceTable.seq })
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                .get()
                .pipe(Effect.orDie)
              observed.push(`notify:${directory}:${row?.seq}`)
            })
          : Effect.void,
      )

      const events = yield* refresh(bus, aggregateID, ["/repo/first", "/repo/second"])

      expect(events.map((event) => event.durable?.seq)).toEqual([Event.Seq.make(1), Event.Seq.make(2)])
      expect(observed).toEqual([
        "project:/repo/first",
        "project:/repo/second",
        "notify:/repo/first:2",
        "notify:/repo/second:2",
      ])
      expect(
        (yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).map(
          (row) => row.seq,
        ),
      ).toEqual([0, 1, 2])
    }),
  )

  it.effect("rolls back every fact of a Command when a projector fails", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const aggregateID = Event.ID.create()
      yield* createProject(bus, aggregateID)
      const notifications = new Array<string>()
      yield* db.run("CREATE TABLE IF NOT EXISTS event_batch_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_batch_probe")
      yield* bus.project(ProjectFact.WorktreeRecorded, (event) =>
        db
          .run(`INSERT INTO event_batch_probe (value) VALUES ('${event.data.directory}')`)
          .pipe(
            Effect.orDie,
            Effect.andThen(event.data.directory === "/repo/second" ? Effect.die("projector failed") : Effect.void),
          ),
      )
      yield* bus.listen((event) =>
        Effect.sync(() => {
          notifications.push(event.type)
        }),
      )

      const exit = yield* refresh(bus, aggregateID, ["/repo/first", "/repo/second"]).pipe(Effect.exit)

      expect(String(exit)).toContain("projector failed")
      expect(yield* db.all("SELECT value FROM event_batch_probe")).toEqual([])
      expect(
        (yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).map(
          (row) => row.seq,
        ),
      ).toEqual([0])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([{ aggregate_id: aggregateID, seq: 0 }])
      expect(notifications).toEqual([])
    }),
  )

  it.effect("does not interleave a concurrent dispatch with a commit's notifications", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const aggregateID = Event.ID.create()
      yield* createProject(bus, aggregateID)
      const firstObserved = yield* Deferred.make<void>()
      const continueNotifications = yield* Deferred.make<void>()
      const observed = new Array<string>()
      yield* bus.listen((event) => {
        if (event.type !== ProjectFact.WorktreeRecorded.type) return Effect.void
        const directory = (event.data as { readonly directory: string }).directory
        return Effect.sync(() => observed.push(directory)).pipe(
          Effect.andThen(directory === "/repo/first" ? Deferred.succeed(firstObserved, undefined) : Effect.void),
          Effect.andThen(directory === "/repo/first" ? Deferred.await(continueNotifications) : Effect.void),
        )
      })

      const batch = yield* refresh(bus, aggregateID, ["/repo/first", "/repo/second"]).pipe(Effect.forkScoped)
      yield* Deferred.await(firstObserved)
      const single = yield* refresh(bus, aggregateID, ["/repo/third"]).pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      expect(observed).toEqual(["/repo/first"])
      yield* Deferred.succeed(continueNotifications, undefined)
      yield* Fiber.join(batch)
      yield* Fiber.join(single)
      expect(observed).toEqual(["/repo/first", "/repo/second", "/repo/third"])
    }),
  )

  it.effect("replays durable aggregate events after a sequence and tails new events", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const aggregateID = Session.ID.create()
      yield* store(bus, durableData(aggregateID, "zero"))
      yield* store(bus, durableData(aggregateID, "one"))
      const fiber = yield* tail(bus, { aggregateID, after: 0 }).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Effect.yieldNow

      yield* store(bus, durableData(aggregateID, "two"))

      expect((yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
        [1, durableData(aggregateID, "one")],
        [2, durableData(aggregateID, "two")],
      ])
    }),
  )

  it.effect("catches durable aggregate events published during replay handoff", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const aggregateID = Session.ID.create()
      yield* store(bus, durableData(aggregateID, "zero"))
      const fiber = yield* tail(bus, { aggregateID }).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)

      yield* store(bus, durableData(aggregateID, "one"))

      expect((yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
        [0, durableData(aggregateID, "zero")],
        [1, durableData(aggregateID, "one")],
      ])
    }),
  )

  it.effect("retains a durable wake committed while historical replay is paused", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>()
      const continueRead = yield* Deferred.make<void>()
      let pause = true
      const eventLayer = AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node]), [
        [
          Bus.node,
          Bus.configured({
            beforeAggregateRead: () =>
              pause
                ? Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(continueRead)))
                : Effect.void,
          }),
        ],
      ])

      yield* Effect.gen(function* () {
        const bus = yield* Bus.Service
        const aggregateID = Session.ID.create()
        const fiber = yield* tail(bus, { aggregateID }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Deferred.await(readStarted)

        pause = false
        yield* store(bus, durableData(aggregateID, "during handoff"))
        yield* Deferred.succeed(continueRead, undefined)

        expect((yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
          [0, durableData(aggregateID, "during handoff")],
        ])
      }).pipe(Effect.provide(eventLayer))
    }),
  )

  it.effect("coalesces durable aggregate wakes while draining every committed event", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const aggregateID = Session.ID.create()
      const count = 64
      const fiber = yield* tail(bus, { aggregateID }).pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      for (let index = 0; index < count; index++) {
        yield* store(bus, durableData(aggregateID, String(index)))
      }

      expect((yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual(
        Array.from({ length: count }, (_, index) => [index, durableData(aggregateID, String(index))]),
      )
    }),
  )

  it.effect("omits live-only events from durable aggregate streams", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const aggregateID = Session.ID.create()
      const fiber = yield* tail(bus, { aggregateID }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* bus.publish(Message, { text: "live only" })
      yield* store(bus, durableData(aggregateID, "durable"))

      expect((yield* Fiber.join(fiber)).map((event) => event.type)).toEqual([DurableMessage.type])
    }),
  )

  it.effect("uses custom sync aggregate field", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const aggregateID = Credential.ID.create()

      yield* bus
        .command({
          type: "createCredential",
          payload: {
            credentialID: aggregateID,
            integrationID: Integration.ID.make("openai"),
            label: "sent",
            secret: { iv: "aXY=", data: "c2VhbGVk" },
          },
        })
        .pipe(Effect.orDie)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("rebuilds an aggregate's projections from Specter's log, without commit hooks or listeners", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const received = new Array<Event.Payload>()
      const committed = new Array<number>()
      const aggregateID = Session.ID.create()
      const first = yield* store(bus, durableData(aggregateID, "first"), {
        commit: (seq) => Effect.sync(() => committed.push(seq)),
      })
      const second = yield* store(bus, durableData(aggregateID, "second"))
      yield* bus.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )
      const notified = new Array<string>()
      yield* bus.listen((event) => Effect.sync(() => notified.push(event.type)))

      yield* bus.rebuild(aggregateID)

      // The log records events without their routing location.
      const recorded = ({ location: _, ...event }: Event.Payload) => event
      expect(received).toEqual([recorded(first), recorded(second)])
      expect(committed).toEqual([0])
      expect(notified).toEqual([])
    }),
  )
  it.effect("rejects an event ID already recorded", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const aggregateID = Session.ID.create()
      const id = Event.ID.create()
      yield* store(bus, durableData(aggregateID, "first"), { id })

      const exit = yield* store(bus, durableData(aggregateID, "second"), { id }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBeTrue()
      expect(
        (yield* Stream.runCollect(bus.log({ aggregateID }))).flatMap((item) => (Bus.isSynced(item) ? [] : [item.data])),
      ).toEqual([durableData(aggregateID, "first")])
    }),
  )
  it.effect("remove clears an aggregate's sequence and index", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      yield* store(bus, durableData(aggregateID, "seed"))

      yield* bus.remove(aggregateID)

      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(yield* Stream.runCollect(bus.log({ aggregateID }))).toEqual([{ type: "log-synced", aggregateID }])
    }),
  )
  it.effect("log without follow replays events and completes with a synced marker", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const aggregateID = Session.ID.create()
      yield* store(bus, durableData(aggregateID, "zero"))
      yield* store(bus, durableData(aggregateID, "one"))

      const items = yield* Stream.runCollect(bus.log({ aggregateID }))

      expect(items.map((item) => (Bus.isSynced(item) ? item.type : item.durable?.seq))).toEqual([
        Event.Seq.make(0),
        Event.Seq.make(1),
        "log-synced",
      ])
      expect(items.at(-1)).toEqual({ type: "log-synced", aggregateID, seq: Event.Seq.make(1) })
    }),
  )

  it.effect("log synced marker omits seq for an empty log and keeps the cursor otherwise", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const aggregateID = Session.ID.create()

      const empty = yield* Stream.runCollect(bus.log({ aggregateID }))
      yield* store(bus, durableData(aggregateID, "zero"))
      const drained = yield* Stream.runCollect(bus.log({ aggregateID, after: 0 }))

      expect(empty).toEqual([{ type: "log-synced", aggregateID }])
      expect(empty[0]).not.toHaveProperty("seq")
      expect(drained).toEqual([{ type: "log-synced", aggregateID, seq: Event.Seq.make(0) }])
    }),
  )

  it.effect("log with follow emits the synced marker at the replay-to-live boundary", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const aggregateID = Session.ID.create()
      yield* store(bus, durableData(aggregateID, "zero"))
      const fiber = yield* bus
        .log({ aggregateID, follow: true })
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* store(bus, durableData(aggregateID, "one"))

      const items = yield* Fiber.join(fiber)
      expect(items.map((item) => (Bus.isSynced(item) ? item : item.durable?.seq))).toEqual([
        Event.Seq.make(0),
        { type: "log-synced", aggregateID, seq: Event.Seq.make(0) },
        Event.Seq.make(1),
      ])
    }),
  )

  it.effect("log replays across configured read pages", () =>
    Effect.gen(function* () {
      const eventLayer = AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node]), [
        [Bus.node, Bus.configured({ logReadPageSize: 2 })],
      ])

      yield* Effect.gen(function* () {
        const bus = yield* Bus.Service
        const aggregateID = Session.ID.create()
        yield* store(bus, durableData(aggregateID, "zero"))
        yield* store(bus, durableData(aggregateID, "one"))
        yield* store(bus, durableData(aggregateID, "two"))
        yield* store(bus, durableData(aggregateID, "three"))
        yield* store(bus, durableData(aggregateID, "four"))

        const items = yield* Stream.runCollect(bus.log({ aggregateID }))

        expect(items.map((item) => (Bus.isSynced(item) ? item.type : item.durable?.seq))).toEqual([
          Event.Seq.make(0),
          Event.Seq.make(1),
          Event.Seq.make(2),
          Event.Seq.make(3),
          Event.Seq.make(4),
          "log-synced",
        ])
        expect(items.at(-1)).toEqual({ type: "log-synced", aggregateID, seq: Event.Seq.make(4) })
      }).pipe(Effect.provide(eventLayer))
    }),
  )

  it.effect("log with follow emits events committed during replay after the synced marker", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>()
      const releaseRead = yield* Deferred.make<void>()
      const firstRead = yield* Ref.make(true)
      const eventLayer = AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node]), [
        [
          Bus.node,
          Bus.configured({
            beforeAggregateRead: () =>
              Ref.getAndSet(firstRead, false).pipe(
                Effect.flatMap((shouldBlock) => {
                  if (!shouldBlock) return Effect.void
                  return Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseRead)))
                }),
              ),
          }),
        ],
      ])

      yield* Effect.gen(function* () {
        const bus = yield* Bus.Service
        const aggregateID = Session.ID.create()
        yield* store(bus, durableData(aggregateID, "zero"))
        const fiber = yield* bus
          .log({ aggregateID, follow: true })
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)

        yield* Deferred.await(readStarted)
        yield* store(bus, durableData(aggregateID, "one"))
        yield* Deferred.succeed(releaseRead, undefined)

        const items = yield* Fiber.join(fiber)
        expect(items.map((item) => (Bus.isSynced(item) ? item : item.durable?.seq))).toEqual([
          Event.Seq.make(0),
          { type: "log-synced", aggregateID, seq: Event.Seq.make(0) },
          Event.Seq.make(1),
        ])
      }).pipe(Effect.provide(eventLayer))
    }),
  )
})
