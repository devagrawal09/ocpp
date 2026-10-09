export * as Cache from "./cache.js"

import { and, asc, eq, gt, gte, lt } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Database } from "./database/database.js"
import { KV } from "./kv.js"
import { CacheTable } from "./cache/sql.js"

/**
 * Copies of external resources kept to avoid fetching them again: the models.dev catalog, and when each
 * repository was last refreshed. They are not OC++'s state, so they are not facts in Specter's log:
 * dropping any entry only means fetching it again.
 */
export type Interface = KV.Interface

export class Service extends Context.Service<Service, Interface>()("@ocpp/Cache") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return Service.of({
      get: Effect.fn("Cache.get")(function* (key) {
        return (yield* db
          .select({ value: CacheTable.value })
          .from(CacheTable)
          .where(eq(CacheTable.key, key))
          .get()
          .pipe(Effect.orDie))?.value
      }),
      set: Effect.fn("Cache.set")(function* (key, value) {
        yield* db
          .insert(CacheTable)
          .values({ key, value })
          .onConflictDoUpdate({ target: CacheTable.key, set: { value, time_updated: Date.now() } })
          .run()
          .pipe(Effect.orDie)
      }),
      remove: Effect.fn("Cache.remove")(function* (key) {
        yield* db.delete(CacheTable).where(eq(CacheTable.key, key)).run().pipe(Effect.orDie)
      }),
      scan: Effect.fn("Cache.scan")(function* (options) {
        const limit = Number.isNaN(options.limit) ? 100 : Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 1000)
        const end = KV.prefixEnd(options.prefix)
        const rows = yield* db
          .select({ key: CacheTable.key, value: CacheTable.value })
          .from(CacheTable)
          .where(
            and(
              options.prefix === "" ? undefined : gte(CacheTable.key, options.prefix),
              end === undefined ? undefined : lt(CacheTable.key, end),
              options.after === undefined ? undefined : gt(CacheTable.key, options.after),
            ),
          )
          .orderBy(asc(CacheTable.key))
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie)
        const entries = rows.slice(0, limit)
        if (rows.length <= limit) return { entries }
        return { entries, next: entries[entries.length - 1].key }
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
