# @ocpp/codemode

This is our take on code mode: a lightweight, pure interpreter for a compiled JavaScript-shaped
language built around direct, blocking tool calls and a durable notebook. See the
[complete Code Mode guide](./interpreter-support.md) for architecture diagrams, notebook semantics,
the durable value model, examples, limits, and the full language contract.

Rather than trying to sandbox arbitrary JavaScript, CodeMode only runs the language features we
implement. Programs cannot directly access the network, filesystem, processes, or application APIs.
They can interact with the outside world only through tools provided by the host, which can also
limit execution time, tool calls, output size, and durable data.

The idea of code mode was originally introduced by Cloudflare. See
[their post](https://blog.cloudflare.com/code-mode/) to learn more about the concept and their
isolate-based approach.

## How it differs from JavaScript

- **Only supported APIs are available.** Programs can use the provided tools and supported JavaScript
  built-ins. APIs such as `fetch`, timers, `process`, filesystem access, imports, and modules are
  unavailable.
- **Tool calls are synchronous.** A direct call returns its decoded value. `await` and `Promise.all`
  are accepted only as compatibility no-ops and produce warnings; other `Promise` syntax and `async`
  are rejected before execution.
- **Values are durable data.** `null`, booleans, finite numbers, strings, immutable arrays,
  string-keyed records, and functions. `Date`, `Map`, `Set`, `URL`, and `URLSearchParams` are replaced
  by the `time` and `url` helpers, which return plain data. Regular expressions are unavailable.
- **Aggregate values are immutable.** Derive arrays and objects with methods such as `map`, `filter`,
  and `slice`, or with spread and literals. Local scalar `let` bindings may be updated.
- **Top-level declarations are durable.** Every direct top-level `const` and `function` declaration is
  saved to the notebook the host provides. `return` is only a preview.

Unsupported syntax returns an `UnsupportedSyntax` diagnostic with a source location. The supported and
rejected forms are listed in the [complete guide](./interpreter-support.md).

## Quick Start

```ts
import { CodeMode, Tool } from "@ocpp/codemode"
import { Effect, Schema } from "effect"

const lookupOrder = Tool.make({
  description: "Look up an order by ID",
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.Struct({ id: Schema.String, status: Schema.String }),
  execute: ({ id }) => Effect.succeed({ id, status: "open" }),
})

const runtime = CodeMode.make({
  tools: { orders: { lookup: lookupOrder } },
})

const result = await Effect.runPromise(
  runtime.execute(`
    const order = tools.orders.lookup({ id: "order_42" })
    const needsAttention = order.status !== "complete"
  `),
)

// result.declarations is { order: ..., needsAttention: true }, ready for the host to save.
```

`result` is always a [`CodeMode.Result`](#results).

## API

### `Tool.make`

`input` and `output` accept either an Effect Schema or a render-only JSON Schema document. Effect
Schema input is decoded before `execute`; Effect Schema output is decoded and safely copied before the
program sees it. JSON Schemas only shape the model-visible signature. Without `output`, the signature
uses `void`.

Descriptions and schemas are model-visible contracts. Authorization belongs in `execute`. Tool calls
return decoded values directly inside an execution.

`acceptsToolHandles: true` lets a tool receive the opaque, activation-local handles a program creates
with `tool.define(...)`; use `isToolHandle` to narrow one and `handle.invoke(input)` to call it. Every
other tool rejects handles, which are never durable. See the
[complete guide](./interpreter-support.md) for handle semantics.

Dots in tool names create namespaces: `{ "issues.list": tool }` and `{ issues: { list: tool } }` both
expose `tools.issues.list(...)`. Other characters use bracket notation, such as
`tools.context7["resolve-library-id"](...)`.

### `CodeMode.execute` and `CodeMode.make`

`CodeMode.execute({ ...options, code })` runs once. `CodeMode.make(options)` creates a reusable
runtime:

```ts
const runtime = CodeMode.make({ tools, limits: { timeoutMs: 30_000 } })

runtime.catalog() // structured tool descriptions
runtime.execute(source) // Effect<CodeMode.Result, never, ToolServices>
runtime.executeCompiled(program) // the same, from a precompiled program
```

`bindings` supplies the notebook values a program can read, as saved by an earlier execution. The
Effect environment is inferred from the supplied tools. `onToolCallStart` observes admitted calls with
decoded input; `onToolCallEnd` observes settled outcomes and duration. `onTrace` observes semantic
JavaScript steps in execution order as `assignment`, `branch`, `operation`, `log`, and `return`
events. All three hooks return Effects and must not fail. `impure` supplies the values `time.now()` and
`Math.random()` return, in the order the program reads them; they are the only helpers whose results
the program and its tool results do not determine. A host that records these values alongside tool
results can replay an execution deterministically, for example to resume it after a restart.

### Compiling ahead of execution

`compile(code)` returns the versioned data-only `Program` a host can persist; `executeCompiled` and
the `program` option replay it without recompiling, which is how a host resumes an execution it
admitted earlier. A persisted program enters execution through `decodeProgram`, which checks the
`IR_VERSION` and shape so a damaged or unsupported program becomes a diagnostic instead of an
interpreter defect. `compile` throws `CompileError` for empty, unparsable, or unsupported source.

### OpenAPI tools

`OpenAPI.fromSpec` converts an OpenAPI 3.x document into one tool per supported operation. Dotted
`operationId` values create namespaces:

```ts
const api = OpenAPI.fromSpec({ spec, auth: { resolve } })
const runtime = CodeMode.make({ tools: { ocpp: api.tools } })
```

The synchronous result is `{ tools, skipped }`. Operations with unsupported parameter encodings,
request bodies without JSON content, WebSocket or SSE semantics, or binary responses are reported in
`skipped`.

Authentication is resolved by the host and never shown to the model. Generated tools require
`HttpClient.HttpClient`. Request signatures omit `readOnly` properties; response signatures omit
`writeOnly` properties. These JSON Schemas shape model-visible signatures but do not filter runtime
values: nested JSON body properties and decoded server responses pass through unchanged. See
`src/openapi/types.ts` for option details.

## Results

Every execution returns:

```ts
type Result =
  | {
      readonly ok: true
      readonly value: CodeMode.DataValue
      readonly declarations: Readonly<Record<string, CodeMode.NotebookValue>>
      readonly warnings?: ReadonlyArray<CodeMode.Diagnostic>
      readonly logs?: ReadonlyArray<string>
      readonly truncated?: boolean
      readonly toolCalls: ReadonlyArray<CodeMode.ToolCall>
    }
  | {
      readonly ok: false
      readonly error: CodeMode.Diagnostic
      readonly logs?: ReadonlyArray<string>
      readonly truncated?: boolean
      readonly toolCalls: ReadonlyArray<CodeMode.ToolCall>
    }
```

`declarations` holds every durable value the program declared at the top level, encoded so the host
can store it and pass it back as `bindings` later. `value` is a JSON-safe preview of the returned
expression, not canonical output. `warnings` are non-fatal diagnostics, `logs` contain program console
output, and `truncated` indicates that retained output was cut by `maxOutputBytes`. `toolCalls`
retains admitted calls in order, including after failure.

Diagnostic kinds:

| Kind                    | Meaning                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `ParseError`            | Source is empty or cannot be parsed.                                |
| `UnsupportedSyntax`     | Parsed JavaScript is outside the supported subset.                  |
| `UnknownTool`           | The program referenced an unavailable tool.                         |
| `InvalidToolInput`      | Tool input failed schema decoding or safe-data copying.             |
| `InvalidToolOutput`     | Tool output failed schema decoding or safe-data copying.            |
| `InvalidDataValue`      | Program data violated the plain-data contract.                      |
| `InvalidDurableValue`   | A declared value cannot be saved durably, or exceeds a value limit. |
| `ToolCallLimitExceeded` | The program exceeded `maxToolCalls`.                                |
| `TimeoutExceeded`       | Execution exceeded its wall-clock deadline.                         |
| `ToolFailure`           | A tool refused or failed.                                           |
| `ExecutionFailure`      | The program threw or another execution error occurred.              |
| `Compatibility`         | Warning only: `await` or `Promise.all` was accepted as a no-op.     |
| `Truncated`             | Warning only: additional warnings were omitted by `maxOutputBytes`. |

Host failures and defects report their messages and underlying causes. Invalid outputs include the
validation or copying error. Interruption propagates without becoming an error diagnostic.

## Discovery

`runtime.catalog()` returns structured descriptors — exact path, description, and generated TypeScript
signature — for every visible tool. Hosts render their own model-facing instructions from these
descriptors; `CodeMode.searchSignature` and `CodeMode.toolExpression(path)` supply the exact callable
forms.

The synchronous `tools.search(...)` built-in is always available. It supports exact-path lookup,
namespace-scoped search, empty-query browsing, and pagination, and returns callable paths with full
signatures. Search counts toward `maxToolCalls`.

## Execution Limits

| Limit                 | Default          | Controls                            |
| --------------------- | ---------------- | ----------------------------------- |
| `timeoutMs`           | unlimited        | Total wall-clock execution time.    |
| `maxToolCalls`        | unlimited        | Admitted tool calls.                |
| `maxOutputBytes`      | unlimited        | Retained preview value.             |
| `maxLogBytes`         | `maxOutputBytes` | Ceiling on retained console output. |
| `maxDeclarationBytes` | unlimited        | Encoded size of one notebook value. |

No limits are enabled by default. When `maxOutputBytes` is set without `maxLogBytes`, the log budget
inherits it. Logs share the output budget rather than owning an independent one: the retained amount
is `min(maxLogBytes, maxOutputBytes - preview bytes)`, so a large preview leaves less room for logs
and a `maxLogBytes` above `maxOutputBytes` is never reached.

Invalid limit configuration throws `RangeError`. Warnings receive a separate budget equal to
`maxOutputBytes`. Preview truncation does not fail execution; an oversized declaration does, with an
`InvalidDurableValue` diagnostic. Timeouts interrupt in-flight tool calls and busy loops before
settlement. Boundary and durable data are limited to 32 nested levels.

### Materialized Value Limits

One value may hold at most **1,000,000 items** — array elements or record keys — and a string at most
**4,000,000 characters**. These are fixed, not host-configurable: the timeout can only interrupt the
interpreter between steps, so an operation such as `Array.from({ length: 4e9 })` or
`"ab".repeat(3e9)` would exhaust the process inside a single native call before any deadline is
observed. Operations whose result size is known in advance — array construction and `Array.from`
lengths, `repeat`, `padStart`, `padEnd`, `concat`, `replaceAll`, `split`, `join`, `flat`, `flatMap`,
spreads, and template literals — check the size before doing the work, and the tool boundary refuses
oversized tool results, so the limit holds for every array a program can observe. Exceeding it fails
the operation with an `InvalidDataValue` diagnostic that a program can catch as a `RangeError`.
