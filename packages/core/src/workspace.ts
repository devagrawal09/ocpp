export * as Workspace from "./workspace.js"

import { Workspace } from "@ocpp/schema/workspace"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { eq } from "drizzle-orm"
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberSet,
  Layer,
  Ref,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { systemError } from "effect/PlatformError"
import { make } from "effect/process/ChildProcessSpawner"
import type { EnvironmentDriver } from "./environment/driver.js"
import { Bus } from "./bus.js"
import { Database } from "./database/database.js"
import { ProjectProjector } from "./project/projector.js"
import { SpecterRejection } from "./specter/rejection.js"
import { WorkspaceDriver } from "./workspace/driver.js"
import { WorkspaceTable } from "./workspace/sql.js"

export const ID = Workspace.ID
export type ID = Workspace.ID

export class Info extends Schema.Class<Info>("Workspace.Info")({
  id: ID,
  provider: Schema.String,
  binding: WorkspaceDriver.Binding,
  createdAt: Schema.Number,
  lastUsedAt: Schema.Number,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("Workspace.NotFound", { workspaceID: ID }) {}

export class CreateConflict extends Schema.TaggedError<CreateConflict>()("Workspace.CreateConflict", {
  workspaceID: ID,
  provider: Schema.String,
  existingProvider: Schema.String,
}) {}

export interface Interface {
  /** Instantly commits a logical workspace ID. No provider work happens here. */
  readonly create: (input: {
    readonly id?: ID
    readonly provider: string
  }) => Effect.Effect<ID, CreateConflict | WorkspaceDriver.ProviderNotFound>
  /** Starts or joins the shared attempt that makes the backing resource real, then returns it. */
  readonly provision: (
    workspaceID: ID,
  ) => Effect.Effect<Info, NotFound | WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound>
  readonly connect: (
    workspaceID: ID,
  ) => Effect.Effect<EnvironmentDriver.Driver, NotFound | WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound>
  /** Makes the workspace absent; reports whether this call destroyed an existing workspace. */
  readonly destroy: (
    workspaceID: ID,
  ) => Effect.Effect<Workspace.DestroyResult, WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound>
}

export interface Options {
  readonly idleThreshold?: Duration.Input
  readonly pollInterval?: Duration.Input
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/Workspace") {}

interface Connection {
  readonly driver: WorkspaceDriver.Interface
  readonly environment: EnvironmentDriver.Driver
  readonly saveBinding: (binding: WorkspaceDriver.Binding) => Effect.Effect<void>
  readonly lastActivity: Ref.Ref<number>
  readonly active: Ref.Ref<number>
  readonly scope: Scope.Closeable
  /** Keeps a spawn attaching to this connection and its idle suspension apart. */
  readonly permit: Semaphore.Semaphore
}

type ReadinessError = NotFound | WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound

export const configured = (options: Options = {}) =>
  makeGlobalNode({
    service: Service,
    layer: layer(options),
    deps: [Database.node, Bus.node, ProjectProjector.node, WorkspaceDriver.node],
  })

// A workspace's facts are the runtime's Commands to decide: createWorkspace, bindWorkspace, useWorkspace and
// destroyWorkspace, each refusing a workspace that is gone. What stays in this process is the provider work in
// flight: one provisioning, one connection being opened and one teardown per workspace at a time, which callers
// join instead of starting again.
const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const bus = yield* Bus.Service
      const registry = yield* WorkspaceDriver.RegistryService
      const lifetime = yield* Scope.Scope
      const connections = new Map<ID, Connection>()
      // Destroy cancels the racing provision body by settling its result, and waits until it has stopped.
      const attempts = new Map<
        ID,
        { readonly result: Deferred.Deferred<Info, ReadinessError>; readonly stopped: Deferred.Deferred<void> }
      >()
      const opening = new Map<ID, Deferred.Deferred<Connection, ReadinessError>>()
      const destroying = new Map<ID, Deferred.Deferred<Workspace.DestroyResult, DestroyError>>()
      const fork = yield* FiberSet.makeRuntime<never, void, never>()
      const idleThreshold = Duration.toMillis(options.idleThreshold ?? Duration.minutes(20))

      const find = (workspaceID: ID) =>
        db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, workspaceID)).get().pipe(Effect.orDie)

      const load = Effect.fn("Workspace.load")(function* (workspaceID: ID) {
        // A workspace being destroyed is gone for new work.
        const row = destroying.has(workspaceID) ? undefined : yield* find(workspaceID)
        if (!row) return yield* new NotFound({ workspaceID })
        return row
      })

      // A workspace's row is the projection of its facts in Specter's Event Log. A Command refused because the
      // workspace is gone fails with NotFound.
      const record = (workspaceID: ID, command: Bus.RuntimeCommand) =>
        bus.command(command).pipe(
          Effect.asVoid,
          Effect.catch((error) => {
            const code = SpecterRejection.code(error)
            return code === "workspace-not-found" || code === "workspace-destroyed"
              ? Effect.fail(new NotFound({ workspaceID }))
              : Effect.die(error)
          }),
        )
      const bind = (workspaceID: ID, binding: WorkspaceDriver.Binding) =>
        record(workspaceID, { type: "bindWorkspace", payload: { workspaceID, binding } })
      const used = (workspaceID: ID, time: number) =>
        record(workspaceID, { type: "useWorkspace", payload: { workspaceID, time } })
      // What a driver records about a workspace that is gone meanwhile changes nothing.
      const saveBinding = (workspaceID: ID) => (binding: WorkspaceDriver.Binding) =>
        bind(workspaceID, binding).pipe(Effect.catchTag("Workspace.NotFound", () => Effect.void))

      const info = (row: typeof WorkspaceTable.$inferSelect, binding: WorkspaceDriver.Binding) =>
        new Info({
          id: row.id,
          provider: row.provider,
          binding,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
        })

      const provision = Effect.fn("Workspace.provision")((workspaceID: ID) =>
        Effect.suspend(() => {
          const existing = attempts.get(workspaceID)
          if (existing) return Deferred.await(existing.result)

          const attempt = { result: Deferred.makeUnsafe<Info, ReadinessError>(), stopped: Deferred.makeUnsafe<void>() }
          attempts.set(workspaceID, attempt)
          fork(
            Effect.gen(function* () {
              const row = yield* load(workspaceID)
              if (row.binding) return info(row, row.binding)
              const driver = yield* registry.get(row.provider)
              const result = yield* driver.create({ workspaceID })
              yield* bind(workspaceID, result.binding)
              return info(row, result.binding)
            }).pipe(
              Effect.raceFirst(Deferred.await(attempt.result)),
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (attempts.get(workspaceID) === attempt) attempts.delete(workspaceID)
                  Deferred.doneUnsafe(attempt.result, exit)
                  Deferred.doneUnsafe(attempt.stopped, Exit.void)
                }),
              ),
              Effect.exit,
              Effect.asVoid,
            ),
          )
          return Deferred.await(attempt.result)
        }),
      )

      const open = Effect.fn("Workspace.open")(function* (workspaceID: ID) {
        const row = yield* load(workspaceID)
        // Bindings are persisted before provision resolves and never nulled; a raced
        // destroy deletes the whole row and surfaces as NotFound from load above.
        if (!row.binding) return yield* Effect.die(`workspace ${workspaceID} has no binding after provision`)
        const driver = yield* registry.get(row.provider)
        const scope = yield* Scope.fork(lifetime)
        const environment = yield* driver
          .connect({ workspaceID, binding: row.binding, saveBinding: saveBinding(workspaceID) })
          .pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
          )
        const now = yield* Clock.currentTimeMillis
        yield* used(workspaceID, now).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))
        const connection: Connection = {
          driver,
          environment,
          saveBinding: saveBinding(workspaceID),
          lastActivity: yield* Ref.make(now),
          active: yield* Ref.make(0),
          scope,
          permit: yield* Semaphore.make(1),
        }
        connections.set(workspaceID, connection)
        return connection
      })

      // The workspace's connection, opening it once however many spawns ask at the same time.
      const connection = (workspaceID: ID) =>
        Effect.suspend(() => {
          const existing = connections.get(workspaceID)
          if (existing) return Effect.succeed(existing)
          const pending = opening.get(workspaceID)
          if (pending) return Deferred.await(pending)
          const opened = Deferred.makeUnsafe<Connection, ReadinessError>()
          opening.set(workspaceID, opened)
          fork(
            open(workspaceID).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  opening.delete(workspaceID)
                  Deferred.doneUnsafe(opened, exit)
                }),
              ),
              Effect.exit,
              Effect.asVoid,
            ),
          )
          return Deferred.await(opened)
        })

      // Attaches a spawn to the workspace's connection; one suspended meanwhile is opened again.
      const attach = (workspaceID: ID): Effect.Effect<Connection, ReadinessError> =>
        connection(workspaceID).pipe(
          Effect.flatMap((current) =>
            current.permit.withPermit(
              Effect.gen(function* () {
                if (connections.get(workspaceID) !== current) return undefined
                yield* Ref.set(current.lastActivity, yield* Clock.currentTimeMillis)
                yield* Ref.update(current.active, (active) => active + 1)
                return current
              }),
            ),
          ),
          Effect.flatMap((attached) => (attached ? Effect.succeed(attached) : attach(workspaceID))),
        )

      yield* Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* Effect.forEach(
          [...connections.entries()],
          ([workspaceID, expected]) =>
            // Deliberate: a racing spawn waits for the permit, then opens the workspace again. Attaching
            // mid-suspend could reattach a sandbox being terminated.
            expected.permit.withPermit(
              Effect.gen(function* () {
                if (connections.get(workspaceID) !== expected || (yield* Ref.get(expected.active)) > 0) return
                const lastActivity = yield* Ref.get(expected.lastActivity)
                if (now - lastActivity < idleThreshold) return
                const row = yield* load(workspaceID)
                if (!row.binding) return
                yield* expected.driver.suspendForIdle({
                  workspaceID,
                  binding: row.binding,
                  saveBinding: expected.saveBinding,
                })
                yield* used(workspaceID, lastActivity)
                connections.delete(workspaceID)
                yield* Scope.close(expected.scope, Exit.void)
              }).pipe(Effect.catchCause((cause) => Effect.logError("workspace idle suspension failed", cause))),
            ),
          { concurrency: "unbounded", discard: true },
        )
      }).pipe(Effect.repeat(Schedule.spaced(options.pollInterval ?? Duration.minutes(1))), Effect.forkScoped)

      const teardown = Effect.fnUntraced(function* (workspaceID: ID) {
        // Settling the shared attempt cancels its racing provision body and fails waiters with NotFound; the
        // teardown starts once the provisioning has stopped. Accepted tradeoffs: if the teardown below fails,
        // those waiters saw NotFound for a workspace that still exists (the next provision retries it).
        const attempt = attempts.get(workspaceID)
        if (attempt) {
          attempts.delete(workspaceID)
          Deferred.doneUnsafe(attempt.result, Exit.fail(new NotFound({ workspaceID })))
          yield* Deferred.await(attempt.stopped)
        }
        // A connection being opened is torn down with the workspace.
        const opened = opening.get(workspaceID)
        if (opened) yield* Deferred.await(opened).pipe(Effect.exit)
        const row = yield* find(workspaceID)
        if (!row) return { destroyed: false }
        const connection = connections.get(workspaceID)
        connections.delete(workspaceID)
        if (connection) yield* connection.permit.withPermit(Scope.close(connection.scope, Exit.void))
        // Null binding still reaches the driver: an interrupted or crashed
        // provision may have created a resource that was never persisted. A
        // provider missing from the registry cannot block deleting a
        // never-provisioned row.
        yield* registry.get(row.provider).pipe(
          Effect.flatMap((driver) => driver.destroy({ workspaceID, binding: row.binding })),
          Effect.catchTag("WorkspaceDriver.ProviderNotFound", (error) =>
            row.binding ? Effect.fail(error) : Effect.void,
          ),
        )
        return yield* record(workspaceID, { type: "destroyWorkspace", payload: { workspaceID } }).pipe(
          Effect.as({ destroyed: true }),
          Effect.catchTag("Workspace.NotFound", () => Effect.succeed({ destroyed: false })),
        )
      })

      return Service.of({
        create: Effect.fn("Workspace.create")(function* (input) {
          const workspaceID = input.id ?? ID.create()
          const conflict = (existingProvider: string) =>
            new CreateConflict({ workspaceID, provider: input.provider, existingProvider })
          // An existing workspace answers before its provider is looked up.
          const existing = yield* find(workspaceID)
          if (existing) return existing.provider === input.provider ? workspaceID : yield* conflict(existing.provider)
          yield* registry.get(input.provider)
          // Created meanwhile under the same ID: the same provider's is this one, another's conflicts.
          return yield* bus
            .command({
              type: "createWorkspace",
              payload: { workspaceID, provider: input.provider, time: yield* Clock.currentTimeMillis },
            })
            .pipe(
              Effect.as(workspaceID),
              Effect.catch((error) => {
                const code = SpecterRejection.code(error)
                if (code === "workspace-already-exists") return Effect.succeed(workspaceID)
                if (code !== "workspace-other-provider") return Effect.die(error)
                return find(workspaceID).pipe(
                  Effect.flatMap((row) => Effect.fail(conflict(row?.provider ?? input.provider))),
                )
              }),
            )
        }),
        provision,
        connect: Effect.fn("Workspace.connect")(function* (workspaceID) {
          const spawner = make((command) =>
            Effect.acquireRelease(
              // A live connection implies the binding is already persisted, so skip the provision hop.
              Effect.suspend(() => (connections.has(workspaceID) ? Effect.void : provision(workspaceID))).pipe(
                Effect.andThen(attach(workspaceID)),
                Effect.mapError((cause) =>
                  systemError({
                    _tag: "Unknown",
                    module: "Workspace",
                    method: "spawn",
                    description: `Failed to wake workspace ${workspaceID}`,
                    cause,
                  }),
                ),
              ),
              (connection) =>
                Effect.gen(function* () {
                  yield* Ref.update(connection.active, (active) => active - 1)
                  yield* Ref.set(connection.lastActivity, yield* Clock.currentTimeMillis)
                }),
            ).pipe(Effect.flatMap((connection) => connection.environment.spawner.spawn(command))),
          )
          // Overrides are connection-bound; per-spawn routing is required before any driver ships them, so they are deliberately omitted.
          return { spawner }
        }),
        destroy: Effect.fn("Workspace.destroy")((workspaceID) =>
          Effect.suspend(() => {
            // A destroy already running decides; this one reports that it destroyed nothing.
            const running = destroying.get(workspaceID)
            if (running) return Deferred.await(running).pipe(Effect.as({ destroyed: false }))
            const done = Deferred.makeUnsafe<Workspace.DestroyResult, DestroyError>()
            destroying.set(workspaceID, done)
            return teardown(workspaceID).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  destroying.delete(workspaceID)
                  Deferred.doneUnsafe(done, exit)
                }),
              ),
            )
          }),
        ),
      })
    }),
  )

type DestroyError = WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound

export const node = configured()

// TODO(workspace-plan): add the boot janitor and ~23h safety snapshot rotation in a later PR.
// TODO(workspace-plan): make cold wake interruptible with a re-pin loop against janitor races.
// TODO(workspace-plan): consider extracting a keyed shared-attempt helper (join/cancel, drop-on-settle):
// provisioning, opening and destroying above hand-roll it, as filesystem/search.ts does. Audited stdlib alternatives (rc.111): RcMap fails twice (refcount release cancels in-flight work when the
// last waiter leaves, and one finalizer path cannot express idle-suspend vs destroy); Cache interrupts the shared
// lookup when its last awaiter is interrupted and cannot fail waiters with NotFound on invalidation.
