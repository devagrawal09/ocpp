import type { DatabaseMigration } from "./migration.js"
import m00 from "./migration/20261010175350_baseline.js"

export const migrations = [m00] satisfies DatabaseMigration.Migration[]
