import { integer } from "drizzle-orm/sqlite-core"

/**
 * When a row was created and last changed. A projection gives both from the fact it projects, so rebuilding
 * it from Specter's log writes the same row: an update changes `time_updated` only when it sets it.
 */
export const Timestamps = {
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
  time_updated: integer()
    .notNull()
    .$default(() => Date.now()),
}
