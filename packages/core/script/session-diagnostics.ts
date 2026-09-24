#!/usr/bin/env bun

// Offline, read-only Code Mode diagnostics over a frozen database snapshot. See
// script/session-diagnostics.md for the report contract and the guarantees below.
//
//   bun run diagnostics:session <snapshot.db> [--holdout 30] [--out report.json]
//
// The snapshot must be frozen: a non-empty write-ahead log or rollback journal beside it is
// refused, and the file is hashed before and after reading so a concurrent write fails the run
// instead of producing a report that no longer matches its recorded hash.

import { Database } from "bun:sqlite"
import { parseArgs } from "util"
import { Effect } from "effect"
import { CodeModeDiagnostics } from "../src/codemode/diagnostics"

const args = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { holdout: { type: "string", default: "30" }, out: { type: "string" } },
})
const path = args.positionals[0]
const holdout = Number(args.values.holdout)
if (path === undefined || !Number.isInteger(holdout) || holdout < 0) {
  console.error("Usage: bun run diagnostics:session <snapshot.db> [--holdout 30] [--out report.json]")
  process.exit(1)
}

const refuseSidecar = () => {
  const suffix = ["-wal", "-journal"].find((suffix) => Bun.file(path + suffix).size > 0)
  if (suffix === undefined) return
  console.error(`Snapshot has a non-empty ${suffix} file; copy it to a standalone frozen database before analysis.`)
  process.exit(2)
}
refuseSidecar()

const hash = async () => {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
  return hasher.digest("hex")
}
const sha256 = await hash()

const db = new Database(path, { readonly: true, strict: true })
const input = await Effect.runPromise(
  CodeModeDiagnostics.load((text) => Effect.sync(() => db.query(text).all() as ReadonlyArray<unknown>)),
)
db.close()
refuseSidecar()
if ((await hash()) !== sha256) {
  console.error("Snapshot changed during analysis; no report was produced.")
  process.exit(3)
}

const report = CodeModeDiagnostics.stringify(
  CodeModeDiagnostics.analyze(input, { holdout, snapshot: { path, sha256 } }),
)
if (args.values.out === undefined) console.log(report)
else await Bun.write(args.values.out, report + "\n")
