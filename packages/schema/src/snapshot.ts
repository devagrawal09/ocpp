export * as Snapshot from "./snapshot.js"

import { Schema } from "effect"
import { brand } from "./schema.js"

export const ID = Schema.String.pipe(brand("Snapshot.ID"))
export type ID = typeof ID.Type
