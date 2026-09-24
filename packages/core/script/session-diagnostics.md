# Session diagnostics

Offline, read-only analysis of Code Mode outcomes in a frozen copy of an OpenCode database.

```
bun run diagnostics:session <snapshot.db> [--holdout 30] [--out report.json]
```

Run it from `packages/core`. The report goes to stdout, or to `--out` when given.

## Guarantees

- **Read-only.** The database is opened read-only and only the four statements recorded in
  `manifest.queries` run.
- **Frozen input only.** A non-empty `-wal` or `-journal` file beside the snapshot is refused
  before and after reading (exit 2). The file is hashed before and after reading; a mismatch aborts without a report
  (exit 3). Copy a live database to a standalone file before analyzing it.
- **Deterministic.** Identical bytes and identical options produce byte-identical output. Input
  rows are sorted canonically on entry, every table has a total order with published tie
  breakers, no timestamps are generated, and object keys are serialized in sorted order.
- **No models.** Classification is structured first (persisted `kind` or typed error) and falls
  back to the ordered rule tables published in `manifest.taxonomy`. Every classification records
  whether it came from a structured field, a named rule, or is unclassified.

## Report

`manifest.schema` names the report contract and `manifest.analyzerVersion` the analyzer; both
change when the meaning of a count changes. `manifest.thresholds`, `manifest.definitions`,
`manifest.taxonomy`, and `manifest.ranking` publish every constant, boundary, rule, and weight.

| Section            | Content                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `events`           | Canonical per-session event counts and one bounded example sequence.                           |
| `strata`           | Execute calls by OpenCode version and observed execute mode, with completion provenance.       |
| `execute`          | Admission versus completion, refusal and failure categories with sources, blind retry loops.   |
| `episodes`         | Failure episodes from first refusal or failed completion to recovery or non-recovery.          |
| `sequences`        | Tool bigrams, per-tool status counts, and category transitions inside episodes.                |
| `cohorts`          | Version, mode, provider, model, child versus top-level, holdout versus training, journal tool. |
| `statistics`       | Nearest-rank quantiles and supported observational effect sizes with Wilson intervals.         |
| `ranking`          | Review candidates ordered by the published weighted components. Not guidance.                  |
| `nested`           | Journal calls, exit codes, and journal failure categories.                                     |
| `terminalFailures` | Sessions whose last execution failed, with the projected error when the snapshot has it.       |
| `quality`          | Join coverage, duplicates, impossible states, and classification source coverage.              |

Every example carries row provenance (`sessionID`, `messageID`, `seq`, `index`, `executionID`
or `callIndex`) so any number can be traced back to its rows.

## Regenerating the golden report

The golden used by `test/codemode-diagnostics.test.ts` is produced from the shared fixture:

```
bun -e 'import { input } from "./test/fixture/codemode-diagnostics"; import { CodeModeDiagnostics } from "./src/codemode/diagnostics"; await Bun.write("test/fixture/codemode-diagnostics.golden.json", CodeModeDiagnostics.stringify(CodeModeDiagnostics.analyze(input, { holdout: 1 })) + "\n")'
```

Review the diff before committing a regenerated golden; it is the contract.
