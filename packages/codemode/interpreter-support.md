# Code Mode: The Durable Notebook

This fork redesigns Code Mode around one idea: **a Session owns an append-only notebook, and running
code is how the model writes into it.** Every direct top-level `const` and `function` declaration
becomes a durable notebook value that later executions can read by name. There is no publication
syntax, no revision negotiation, and no separate durable result payload.

The implementation has two deliberate layers:

- `@ocpp/codemode` compiles and evaluates a restricted JavaScript-shaped language over an
  explicit catalog of schema-described tools, and encodes the values a program declares. It has no
  Session, database, authorization, or delivery knowledge.
- OC++ Core supplies the authorized tool catalog, fixed safety limits, name admission and
  reservation, durable storage, Session lifecycle integration, and model-facing delivery.

```mermaid
flowchart LR
    Model[Model] -->|execute code| Core[OC++ Core host]
    Core -->|source| Compiler[Compiler]
    Compiler -->|versioned IR + declared names + tool paths| Admission[Admission]
    Admission -->|reserve names, snapshot notebook| Store[(Durable notebook)]
    Admission -->|execution ID| Model
    Admission --> Runtime[Confined interpreter]
    Core -->|authorized catalog| Runtime
    Runtime -->|exact static call| Tools[Core tool registry]
    Tools -->|decoded result| Runtime
    Runtime -->|declared values| Commit[Commit]
    Commit -->|all or nothing| Store
    Commit -->|bounded summary| Model
```

OC++ offers the model exactly one tool, `execute`. Every host tool, MCP tool, subagent, and external
agent is reachable only from code, so each action the model takes is a program with a visible trace.

The interpreter never reaches around the tool registry. Filesystem, network, process, and
application effects are available only when the host exposes a named tool that performs them.

## Feature Summary

| Feature                | Behavior                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic publication  | Direct top-level `const` and `function` declarations are saved. No `export` syntax exists.                                                |
| Immutable names        | A notebook name is written once and can never be redefined or reused.                                                                     |
| Admission              | Tool paths and names are checked before an execution ID exists. Unavailable tools and name conflicts refuse immediately.                  |
| Fixed snapshots        | An execution sees exactly the completed notebook captured when it was admitted.                                                           |
| All-or-nothing saving  | Success saves every declaration in one transaction; any failure saves none.                                                               |
| Durable functions      | Closures are saved with their compiled body and exact captures, and re-authorize tools on call.                                           |
| Plain durable data     | `null`, booleans, finite numbers, strings, immutable arrays, string-keyed records, functions.                                             |
| Asynchronous execution | `execute` returns an execution ID; the outcome arrives as one later notification.                                                         |
| Bounded lifecycle      | Status, saved names, diagnostics, logs, tool-call journal, and a small preview are bounded.                                               |
| Blocking tool calls    | `tools.repository.read(input)` returns its decoded result directly. `await` and `Promise.all` are warning-producing compatibility no-ops. |

Calls within one execution always run serially, including subagent calls. To run independent
subagents concurrently, issue one `execute` invocation per subagent; never put parallel subagent
work in the same execution.

## Quick Start

Tool paths are catalog-dependent. The examples below use an illustrative `repository` namespace; use
`tools.search` to find the paths and schemas exposed by the current host.

```ts
const matches = tools.repository.glob({ pattern: "src/**/*.ts" })
const files = matches.slice(0, 20).map((item) => tools.repository.read({ path: item.path }))
const lastScan = {
  files: matches.length,
  totalLines: files.reduce((total, file) => total + file.content.split("\n").length, 0),
}
return lastScan.totalLines
```

That program saves three notebook values: `matches`, `files`, and `lastScan`. A later execution reads
them by name:

```ts
const largest = files.toSorted((left, right) => right.content.length - left.content.length)[0]
```

The `return` value is a small preview for display only. It may be truncated or omitted, and it is
never the canonical output: publish real results as top-level declarations.

If the exact catalog path or signature is unknown, discover it and call the returned static path in a
later execution:

```ts
return tools.search({ query: "read file", namespace: "repository" })
```

Do not assign a discovered path to a variable and invoke it dynamically. Dynamic dispatch is
intentionally rejected.

## What Is Saved

Only **direct** top-level declarations are durable:

```ts
const kept = 1 // saved
function alsoKept() {
  const temporary = 2 // not saved
  return temporary
}
let counter = 0 // not saved: let is local working state
{
  const hidden = 3 // not saved
}
for (const item of [1, 2]) {
  const looped = item // not saved
}
```

Deterministic rules keep extraction precise:

- A top-level `const` declarator must bind one identifier. Top-level destructuring is rejected;
  destructure inside a block or function instead.
- A top-level `const` declarator must have an initializer.
- Top-level `function` declarations are saved under their own name.
- `let`, nested declarations, and declarations inside control flow are activation-local.
- `export` in any form is rejected: publication is automatic.
- `const handle = tool.define(...)` is rejected before execution, because a live handle cannot be
  saved. Bind it with `let`, or create it inside a function.
- A durable name may not be a runtime global such as `time`, `url`, `console`, `JSON`, `Object`,
  `Math`, `Array`, `String`, `Error`, `tools`, or `tool`. A notebook name is permanent, so
  shadowing a builtin would hide it from every later execution in the Session. Nested bindings are
  ordinary lexical scoping and may use any name.
- A `return` outside a function is rejected when a later top-level statement declares a durable name,
  because that name would be reserved and never initialized. The rule is syntactic rather than a
  control-flow analysis: it does not ask which branch runs. A final preview `return` placed after
  every declaration stays valid, and so does a `return` in a program that declares nothing after it.

```ts
const first = tools.repository.read({ path: "a.ts" })
if (first.content === "") {
  return "nothing to do" // rejected: `later` below would never be saved
}
const later = first.content.length
```

## Admission And Name Reservation

Before returning an execution ID the host compiles the source, checks every tool path the program
calls against the agent's catalog, extracts every durable name, captures the current completed
notebook, verifies and reserves all candidate names atomically, and persists the admitted execution
with its compiled IR, its ownership identity, and its snapshot. Compilation is
source in and versioned IR out: the compiler knows nothing about Sessions, tools, authorization, or
storage, and the persisted IR keeps its canonical source so a later compiler can recompile it.

A compiled program reaches the interpreter through exactly one boundary. `decodeProgram` checks the
IR version and shape, and an unsupported or damaged program becomes a diagnostic instead of an
interpreter defect. Saved notebook functions cross the same kind of boundary when they are decoded.

```mermaid
sequenceDiagram
    participant M as Model
    participant C as Core host
    participant N as Notebook

    M->>C: execute(code)
    C->>C: compile, extract declared names and tool paths
    alt unsupported syntax, or a tool this agent cannot use
        C-->>M: compile error with suggestions, no execution ID, no tool calls
    end
    C->>N: verify and reserve every name (atomic)
    alt name already defined or reserved
        N-->>C: conflict
        C-->>M: admission error, no execution ID, no tool calls
    else all names reserved
        N-->>C: reservation + notebook snapshot
        C-->>M: execution ID (running)
    end
```

- Unsupported syntax produces an immediate `ParseError` or `UnsupportedSyntax` error with its
  position, the failing source line, and concrete suggestions. See [Compile-Time Checks](#compile-time-checks).
- A tool path outside the agent's catalog produces an immediate `UnknownTool` error, and a path whose
  tool the agent's permission rules deny outright produces `ToolDenied`.
- An existing binding produces an immediate `NameAlreadyDefined` error.
- An active reservation produces an immediate `NameReserved` error that names the owning execution.
- A refused program receives **no execution ID** and performs **no tool calls**.
- Reservations are all-or-none and owned by one execution ID.
- Executions declaring disjoint names may reserve and run concurrently; their results merge because
  the notebook has no global revision. Executions declaring the same name cannot.
- Commit verifies that the execution still owns every reservation and that the assistant message it
  was admitted from still exists.
- Runtime failure, tool failure, cancellation, reverted ownership, and restart recovery save nothing
  and release the reservations.

## Execution Lifecycle

Execution is durable and asynchronous. There is one flow: `execute` accepts source code, returns an
execution ID once admission succeeds, and delivers the outcome later.

```mermaid
sequenceDiagram
    participant M as Model
    participant C as Core host
    participant J as Session jobs
    participant N as Notebook

    M->>C: execute(code)
    C->>N: admit, reserve names, snapshot
    C-->>M: execution ID (running)
    Note over C,J: Work starts only after the outer tool result commits
    J->>C: run compiled IR
    C->>N: commit declarations, or release reservations
    C-->>M: one completion notification with status and saved names
```

The Session drain stops after admission and resumes from the completion notification, so background
work can never settle before the execution ID is durably visible. Coalesced wakeups are fine; the
design does not depend on exactly one scheduler wake.

Terminal outcomes are:

| Outcome         | Meaning                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `saved`         | The program succeeded and every declaration was committed.                        |
| `failed`        | Compilation, execution, a tool, a limit, or the commit failed. Nothing was saved. |
| `indeterminate` | The host could not determine whether in-flight work finished. Nothing was saved.  |

Name collisions are admission errors, not asynchronous outcomes.

## Durable Value Model

Every value admitted for notebook storage survives execution, restart, fork, and revert:

- `null`, booleans, finite numbers, and strings
- immutable arrays
- immutable string-keyed plain records
- durable functions and closures

`Date`, `Map`, `Set`, `URL`, and `URLSearchParams` are not language values; the `time` and `url`
helpers replace them with plain data. `RegExp` has no replacement at all. Native JavaScript objects
still exist inside helper implementations, but they never cross into notebook values.

A durable function keeps:

- its versioned compiled body and its original source text,
- its exact captures, frozen when the execution saves,
- static tool paths, which are resolved and authorized again in the execution that invokes it.

A saved closure never looks up a later notebook value by name: every free identifier is either a host
global (`tools`, `console`, `Math`, `JSON`, `time`, `url`, …) or a captured value stored with the
function. A function that reads an identifier which does not exist when the execution saves is
rejected. Fixes use new names and new closures.

```ts
// First execution
const factor = 3
const scale = (value) => value * factor
function total(values) {
  return values.reduce((sum, value) => sum + scale(value), 0)
}

// A later execution, even after a restart
return total([1, 2]) // 9
```

Recursive and mutually recursive declarations are saved as references to their immutable notebook
names, so their capture graphs stay finite.

Live activation-local tool handles are not durable: they carry the current execution's counters,
deadline, and authorization, so they are rejected clearly instead of being weakened.

Depth and size limits apply while values are constructed, so an invalid or oversized declaration
fails during execution rather than surprising the host at commit. Intentionally large artifacts
belong in files through host tools.

Encoding normalizes what JSON cannot represent: an array hole and an `undefined` value become
`null`, `-0` becomes `0`, and a record key whose value is `undefined` is dropped. A value therefore
behaves the same in the execution that declared it and in every later execution that loads it from
storage.

A stored value that cannot be decoded — damaged data, or a function saved by an unsupported IR
version — is quarantined in its own name rather than failing the whole activation. Unrelated code
still runs; reading the name, or reading a stored value that references it, produces a precise
diagnostic naming the value and its cause. The name stays permanent: recovery is a new name, or a
revert of the message that saved it.

## Runtime Helpers

Helpers return plain durable data only.

| Namespace | Members                                                            | Returns                   |
| --------- | ------------------------------------------------------------------ | ------------------------- |
| `time`    | `now`, `parse`, `format`, `parts`, `fromParts`, `add`, `diff`      | numbers, strings, records |
| `url`     | `parse`, `format`, `parseQuery`, `formatQuery`, `encode`, `decode` | strings, records, arrays  |

```ts
const at = time.parse("2020-01-02T03:04:05Z") // epoch milliseconds, or null
const tomorrow = time.format(time.add(at, { days: 1 }))
const parsed = url.parse("https://example.dev/a?x=1&x=2#frag")
```

`time.now()` reads host authority and is the only impure member; it does not masquerade as a pure
function. Collections use ordinary immutable arrays and records with the usual non-mutating methods.

### Regular Expressions Are Unavailable

There is no `regex` namespace, no `RegExp`, and no regular-expression literal. The only matcher
available to this runtime is a backtracking one, and a pattern such as `^a*a*a*a*a*$` makes it run
for effectively unbounded time inside the host's event loop, where the execution deadline cannot
interrupt it. Restricting the accepted pattern syntax does not fix that: the rejected constructs are
not the only way to build a pathological pattern. Pattern matching stays unavailable until the
runtime has an engine whose cost is bounded by the length of the input.

Match text with string operations instead:

```ts
const line = "id-42 ok"
const id = line.startsWith("id-") ? line.slice(3, line.indexOf(" ")) : null
const fields = line.split(" ")
```

`String.match`, `String.matchAll`, and `String.search` are removed; `String.split`, `String.replace`,
and `String.replaceAll` accept string separators only.

## Results

Notebook bindings are the only canonical successful data output. The host keeps compact durable
lifecycle information for status and recovery:

- execution ID and terminal status,
- saved names,
- diagnostics,
- bounded warnings, logs, and progress,
- a bounded tool-call journal,
- an optional small preview of the returned value.

There is no `execution_result` tool, no result paging, no durable result blob, and no overflow file.
An oversized declaration fails clearly instead of being truncated into the notebook.

Images and PDFs cannot be notebook values, so OC++ Core collects the inline images and PDFs that tool
calls return and attaches them to the completion notification, where the model sees them as media.
Images are resized with the same limits as prompt attachments, duplicates attach once, at most eight
files attach to one completion, and the notification names any file it had to omit. Attachments stay
in memory until the notification is delivered, so a completion recovered after a restart carries none.

## Fork, Revert, And Restart

Binding rows record the assistant-message sequence they were saved from, which is enough to rebuild
notebook state without a global revision gate:

- A fork copies completed values through the fork boundary. Active reservations are never copied, so
  a forked Session may declare a name its parent is still holding.
- An in-flight execution belongs to the Session and history lineage where it was admitted. Its
  completion notification and the values it saves stay on the parent, so the fork rewrites the copied
  tool result that announced it: the child sees an execution that stayed behind rather than one that
  promises a notification it will never receive. This mirrors running shell and compaction messages,
  which a fork leaves behind entirely.
- A committed revert deletes values saved from its boundary onward and releases the reservations it
  orphans. An execution whose initiating message is gone saves nothing.
- Reusing a Session ID adopts its existing notebook.
- Restart marks uncertain in-flight executions `indeterminate`, saves nothing, and releases their
  reservations. Arbitrary tool side effects are never replayed.

## Language

### Supported

- Erasable TypeScript syntax that transpiles to supported JavaScript.
- JSON-like literals and template literals.
- Object and array spread and destructuring (outside top-level `const`).
- Synchronous function declarations, function expressions, arrow functions, closures, recursion,
  parameters, and callbacks.
- Blocks, `if`, `switch`, `for`, `for...of`, `for...in`, `while`, and `do...while`.
- `break`, `continue`, labels, `try`, `catch`, `finally`, and `throw`.
- Arithmetic, comparison, logical, nullish, bitwise, and conditional expressions.
- Assignment to local scalar `let` bindings.
- Optional chaining and property reads.
- Non-mutating Array, Object, String, Number, Math, and JSON operations implemented by the evaluator.
- The `time` and `url` helper namespaces.
- Captured `console.log`, `console.info`, `console.debug`, `console.warn`, `console.error`,
  `console.dir`, and `console.table` output.
- Literal bracket notation for tool path segments that are not JavaScript identifiers.
- Synchronous `tools.search(input)` for bounded catalog discovery. Search counts as a tool call.

### Rejected

- `export` in any form.
- `Promise` other than compatibility `Promise.all`, `async`, generators, `yield`, and `for await...of`.
- `Date`, `RegExp`, `Map`, `Set`, `URL`, `URLSearchParams`, regular-expression literals, and the
  `regex` namespace.
- Dynamic tool dispatch such as `tools[name](input)`, detached tool references, and namespace
  enumeration.
- Imports, dynamic imports, re-exports, and ambient modules.
- `var`.
- Member assignment, member updates, `delete`, destructuring into members, and loop assignment into
  members.
- Mutating Array and Object methods.
- Classes and `this`.
- Other evaluator syntax not explicitly implemented, such as tagged templates.
- Ambient filesystem, process, network, timer, `fetch`, module-loading, or cryptographic authority.

The compiler catches unsupported forms before execution and suggests the supported rewrite. Runtime
checks provide a second boundary for computed mutator names and evaluator references.

## Compile-Time Checks

`execute` rejects a program before it has an execution ID, and before any tool runs, when:

- the source cannot be parsed or uses syntax outside the supported subset, or
- it calls a tool path this agent cannot use at all.

Calls must name their tool with a static path (dynamic dispatch is rejected), so the compiler knows
every tool a program can call. `staticToolCalls(program.body)` lists them, including calls inside
functions and tool handles that never run. OC++ Core refuses a path that is not in the agent's
catalog as `UnknownTool`, and a path whose tool the agent's permission rules disable outright as
`ToolDenied`. The check reuses the rule that builds the catalog, so a tool allowed for some
resources is not refused. Permissions that depend on arguments, such as a shell command pattern or a
file path computed at runtime, cannot be decided statically; each tool still checks those when it is
called. A saved notebook function keeps its own tool paths, which are authorized again when it runs.

Every refusal carries `suggestions`: short, concrete rewrites that reuse the program's own names where
they are simple. The model sees the message, its position, the failing source line, and each
suggestion on its own line:

```text
Unknown tool tools.fs.raed; this agent has no tool at that path. (line 2, col 14)
Source: const text = tools.fs.raed({ path })
Did you mean tools.fs.read?
Check its exact signature with tools.search({ query: "tools.fs.read" })
```

```text
Regular expressions are not available; match text with string methods such as includes, startsWith, indexOf, slice, and split. (line 1, col 36)
Source: const ids = lines.filter((line) => /^id-/.test(line))
Replace /^id-/.test(line) with line.startsWith("id-")
```

| Rejected                                  | Suggested                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `/^id-/.test(line)`                       | `line.startsWith("id-")`; `includes` and `endsWith` for other anchors        |
| `text.split(/\s+/)`                       | `text.split(" ").filter((part) => part !== "")`                              |
| `name.replace(/-/g, "_")`                 | `name.replaceAll("-", "_")`                                                  |
| `const inspect = tool.define(...)`        | `let inspect = tool.define(...)`, or create the handle inside a function     |
| `const { branch, files } = status`        | `const result = status; const branch = result.branch; ...`, or `let { ... }` |
| `tools[name](input)`                      | `tools.search({ query })`, then a direct path or an explicit branch          |
| `items.push(item)`, `items.sort(compare)` | `[...items, item]`, `items.toSorted(...)`                                    |
| `record.count += 1`                       | `{ ...record, count: record.count + 1 }`                                     |
| `new Date()`, `new Map()`, `new Set()`    | `time.*` helpers, records, arrays                                            |
| unknown tool path                         | close catalog paths, the namespace's tools, and `tools.search({ query })`    |
| tool denied outright                      | an allowed tool from `tools.search`, or a permission change by the user      |

## Immutability Model

`let` exists for local scalar state:

```ts
let total = 0
;[1, 2, 3].forEach((value) => {
  total += value
})
const sum = total
```

Aggregate values are immutable. Derive replacements with `map`, `filter`, `slice`, spread, and object
literals. Notebook values are immutable even when they are arrays or records, and compiler validation
rejects assignment targets hidden in destructuring and loop forms.

## Opaque Tool Handles

`tool.define` creates a delegated tool that exists only for the current execution:

```ts
let inspect = tool.define({
  name: "inspect",
  description: "Read one source file and return numbered matching lines",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, pattern: { type: "string" } },
    required: ["path", "pattern"],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: { line: { type: "number" }, text: { type: "string" } },
      required: ["line", "text"],
    },
  },
  execute: (input) =>
    tools.repository
      .read({ path: input.path })
      .content.split("\n")
      .map((text, index) => ({ line: index + 1, text }))
      .filter((item) => item.text.toLowerCase().includes(input.pattern.toLowerCase())),
})

const review = tools.subagent({
  agent: "build",
  description: "Review error handling",
  message: "Use inspect to find error-handling branches in src/worker.ts, then explain the gaps.",
  tools: [inspect],
})
```

Handle guarantees:

- Captured bindings are snapshotted at definition time and made immutable.
- Direct static tool calls in the execute function become enforced capabilities; calls hidden behind
  captured helpers are rejected.
- The handle uses the outer execution's filtered catalog, authorization, counters, hooks, and
  deadline.
- Only host tools with `acceptsToolHandles: true` may receive handles.
- Handles are opaque, are not data, cannot be saved, and become inactive when the execution settles.

## Subagent Data Plane

A subagent call carries two planes. `message` is shown to the child in full. `input` is never
rendered into either model's context: it is available directly as `input` in the child's Code Mode
executions, so a notebook value travels by reference in source instead of being pasted into a prompt:

```ts
const review = tools.subagent({
  agent: "build",
  description: "Summarize the dataset",
  message: "Read the machine input, summarize its dataset, and submit the totals.",
  input: { dataset },
  inputSchema: { type: "object", required: ["dataset"] },
  outputSchema: {
    type: "object",
    properties: { total: { type: "number" } },
    required: ["total"],
  },
})
```

The child's prompt says only that machine input is available and describes its shape and size. The
child can use it directly, for example `const total = input.dataset.length`. The value is
invocation-local rather than a notebook binding; declarations derived from it follow the ordinary
durable rules, and saved functions capture the exact input value they used. Each continuation may
provide fresh input. When `inputSchema` is given, the host validates `input` against it before any
child session exists.

A structured child finishes with `tools.submit_result({ message, output })`. The parent's tool
result renders `message` in full and only a short summary of `output` in metadata; the complete
`output` stays in the returned value, so `review.output.total` is available to later computation
through the notebook without ever entering the parent's context as text.

## Limits

OC++ Core applies these fixed host limits. A program cannot raise or lower them.

| Resource                          |     Limit |
| --------------------------------- | --------: |
| Tool calls                        |       100 |
| One durable notebook value        |   256 KiB |
| Declarations per execution        |        64 |
| Notebook values per Session       |       512 |
| Notebook bytes per Session        |     8 MiB |
| Captured journal input or output  |   256 KiB |
| Model-facing preview              |     4 KiB |
| Captured logs                     |     4 KiB |
| Completion summary                |     8 KiB |
| Captured tool and trace events    |  100 each |
| One captured event value          |     4 KiB |
| Concurrent executions per Session |        10 |
| Durable value depth               |        32 |
| Items in one array or record      | 1,000,000 |
| Characters in one string          | 4,000,000 |

There is no wall-clock limit. Core supplies no execution deadline, so a program runs until it
settles, is cancelled, or the host restarts.

Logs share the preview budget rather than owning an independent one: retained console output is
whatever remains of the 4 KiB model-facing preview after the returned value is counted. Core also
sets a 64 KiB log ceiling, but that sharing keeps it out of reach.

Notebook names are append-only, so a Session's notebook only ever grows. The per-execution
declaration count is checked at admission, before any tool runs, and is refused with the same
`NotebookLimitExceeded` kind as a name conflict: no execution ID, no tool calls, no reservation. The
per-Session totals are checked at admission too, and checked again inside the commit transaction,
because two executions can both pass admission and only collide when they save. A refused commit
saves nothing and releases its reservations. Reverting the messages that saved values no longer
needed is how a Session reclaims room.

The standalone `@ocpp/codemode` package remains host-neutral and applies only the limits its
host supplies, including the optional `timeoutMs` deadline Core currently leaves unset. When a host
does supply one, the deadline includes in-flight tool calls: a timeout interrupts the tool fiber and
waits for interruption cleanup before settlement. If the program had already returned and its
declarations were already encoded, the timeout only interrupts leftover background work: the encoded
declarations are still reported, with the timeout recorded as a warning.

The last two limits are the exception: they belong to the interpreter itself, not to the host, and no
host can raise them. A deadline can only interrupt the interpreter between steps, so one operation
that asks for four billion array slots or a gigabyte-long string would exhaust the process inside a
single native call before any deadline is observed. Operations whose result size is known before the
work starts check it first — array construction and `Array.from` lengths, `repeat`, `padStart`,
`padEnd`, `concat`, `replaceAll`, `split`, `join`, `flat`, `flatMap`, spreads, and template literals —
and the tool boundary refuses an oversized tool result, so every array a program can observe is
already within the limit. Exceeding it fails the operation with an `InvalidDataValue` diagnostic that
the program can catch as a `RangeError`:

```ts
const rows = Array.from({ length: 4_000_000_000 }) // InvalidDataValue, before any allocation
const wide = "ab".repeat(3_000_000_000) // InvalidDataValue, before the native repeat
```

## Diagnostics

| Kind                    | Meaning                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ParseError`            | Source is empty or cannot be parsed.                                                                                         |
| `UnsupportedSyntax`     | Parsed JavaScript is outside the supported subset.                                                                           |
| `UnknownTool`           | The program referenced an unavailable tool.                                                                                  |
| `InvalidToolInput`      | Tool input failed schema decoding or safe-data copying.                                                                      |
| `InvalidToolOutput`     | Tool output failed schema decoding or safe-data copying.                                                                     |
| `InvalidDataValue`      | Program data violated the plain-data contract.                                                                               |
| `InvalidDurableValue`   | A declared value cannot be saved durably, exceeds a value limit, or a stored value read by the program could not be decoded. |
| `ToolCallLimitExceeded` | The program exceeded its tool-call limit.                                                                                    |
| `TimeoutExceeded`       | Execution exceeded its wall-clock deadline.                                                                                  |
| `ToolFailure`           | A tool refused or failed.                                                                                                    |
| `ExecutionFailure`      | The program threw or another execution error occurred.                                                                       |
| `Compatibility`         | Warning only: `await` or `Promise.all` was accepted as an ignored no-op.                                                     |
| `Truncated`             | Warning only: output was cut by the output limit.                                                                            |

Admission errors are reported by the host with a stable `kind` of `NameAlreadyDefined`,
`NameReserved`, or `NotebookLimitExceeded`, plus the names involved. The host's compile-time tool
check reports `UnknownTool` or `ToolDenied` with the rejected paths. Compiler diagnostics include a
one-based `location` when available and `suggestions` for rejected syntax, and a `ParseError` also
carries an `excerpt` of the failing source line so the failure can be understood without the whole
program. OC++ Core adds the excerpt for every compile refusal. Host failures preserve their useful
messages, and interruption remains interruption rather than a generic failure.

## Authorization And Trust Boundaries

Code Mode does not invent a second permission system. The host controls authority by exposing only
the tools available to the current request, refusing at compile time a program that calls a tool
outside that catalog, running normal domain authorization inside each tool,
marking the few tools allowed to receive opaque handles, and applying the same hooks and permission
flow used by native tool calls. Saved closures re-resolve and re-authorize their tool paths in the
execution that invokes them, so authority is never captured.

Tool output and execution data are untrusted data, not instructions. Completion summaries frame
previews and logs explicitly and neutralize spoofable markers and tags.

## Implementation Map

- `src/ir.ts`: the versioned data-only program representation and the `decodeProgram` boundary.
- `src/compiler.ts`: transpilation, versioned IR, declaration extraction, and rejected syntax.
- `src/suggestions.ts`: concrete rewrites attached to rejected syntax.
- `src/interpreter/captures.ts`: lexical free-variable analysis for durable closures.
- `src/interpreter/durable.ts`: notebook value encoding, decoding, and limits.
- `src/interpreter/runtime.ts`: evaluator, immutability, closures, handles, and capability enforcement.
- `src/globals.ts`: the shared global-name lists the runtime binds and the compiler reserves.
- `src/stdlib/time.ts`, `src/stdlib/url.ts`: plain-data helpers.
- `src/tool-runtime.ts`: schema boundaries, catalog lookup, call accounting, and host hooks.
- `../core/src/codemode/store.ts`: admission, reservations, commit, journal, fork, revert, recovery.
- `../core/src/codemode/tool.ts`: the asynchronous `execute` tool, progress, and bounded summaries.
- `../core/src/codemode/compile-check.ts`: compile refusals and the static tool-path check.
- `../session-ui/src/tools/tool-renderer.tsx`: Session timeline rendering.

Direct contract tests live in `test/notebook.test.ts`, compile suggestions in `test/diagnostics.test.ts`,
and durable lifecycle tests in Core's `test/codemode-store.test.ts`, `test/tool-execute.test.ts`,
`test/codemode-compile-check.test.ts`, and `test/tool-registry.test.ts`.
