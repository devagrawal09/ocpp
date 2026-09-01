# Compiled Activation Language

Code Mode compiles a restricted JavaScript-shaped language to validated, versioned IR before execution. The compiler and direct tests are the source of truth for this contract.

## Execution Model

- Source is transpiled from erasable TypeScript, parsed as an ES module, validated, and emitted as Program IR with an explicit version.
- Tool calls are direct and blocking. A call such as tools.fs.read(input) returns its decoded result, not a Promise.
- Tools are available only through exact static paths from the host catalog. Literal bracket segments are supported for non-identifiers.
- search(input) synchronously discovers catalog entries and counts as a tool call.
- The result comes from an explicit top-level return, the final top-level expression, or null.
- Inputs, results, exports, tool arguments, and tool results cross JSON-like copy boundaries.
- Each execution has independent wall-clock, tool-call, result, log, and host-capture budgets.

## Bindings And Publication

- const declares immutable values.
- let is available for activation-local scalar working state, including updates from synchronous callbacks and closures.
- var is rejected.
- Host-provided notebook bindings are immutable.
- Arrays and objects are immutable. Member assignment, member updates, delete, and mutating methods are rejected.
- Durable publication uses unconditional direct top-level declarations in the form export const name = value.
- Default exports, re-exports, exported functions, exported let, destructured exports, and conditional exports are rejected.
- A host commits all exports transactionally against the activation base revision. Stale publication fails with RevisionConflict and publishes nothing.

## Supported Syntax

- JSON-like literals, template literals, and regular-expression literals.
- Object and array spread and destructuring.
- Synchronous function declarations, function expressions, arrow functions, closures, recursion, parameters, and callbacks.
- Blocks, if, switch, for, for-of, for-in, while, and do-while.
- break, continue, labels, try, catch, finally, and throw.
- Arithmetic, comparison, logical, nullish, bitwise, conditional, assignment to let, optional chaining, and property access expressions.
- Non-mutating Array, Object, String, Number, Math, JSON, Date, RegExp, Map, Set, URL, and URLSearchParams operations implemented by the evaluator.
- Captured console.log, console.info, console.warn, console.error, console.dir, and console.table output.

## Rejected Syntax And Authority

- Promise, async, await, generators, yield, and for-await-of.
- Dynamic tool dispatch, detached tool references, and enumeration of tool namespaces.
- Imports, dynamic imports, and re-exports.
- Aggregate mutation, including mutating Date, Map, Set, Array, and object methods.
- Ambient filesystem, process, network, module, timer, fetch, and cryptographic authority.
- Classes and evaluator syntax not explicitly supported by the implementation.

## Opaque Tool Handles

tool.define(...) creates an opaque same-activation handle for delegated tools. Its definition requires a name, description, input schema, output schema, and synchronous execute function.

The handle snapshots the function closure, records and enforces statically referenced tool capabilities, uses the outer filtered runtime and its counters, hooks, timeout, and authorization, and becomes invalid when the activation ends. Tool calls hidden behind captured helper functions are rejected because they are not declared capabilities. Handles cross only host tool boundaries that explicitly opt in to receiving them; they are not JSON data and cannot be persisted or invoked by a later activation.

## Diagnostics

Compilation and execution return structured diagnostics. Stable kinds include parse errors, unsupported syntax, unknown tools, invalid tool input or output, invalid data, tool-call exhaustion, timeout, tool failure, execution failure, revision conflict, and truncation. Compiler diagnostics include source locations when available and recommend the blocking, immutable activation language rather than legacy Promise syntax.
