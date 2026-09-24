# @opencode-ai/codemode

- This local package owns confined execution over explicit schema-described tools. Applications own authorization, persistence, external authority, and tool-specific delivery semantics.
- Do not add a speculative generic permission or approval policy. A host omits tools it does not expose and enforces domain authorization inside each provided tool.
- Keep Code Mode unaware of host session, channel, and conversation models. The hosting application supplies trusted execution scope around it.
- Tool schemas are the model-facing Interface. Keep arguments minimal and natural to the operation; never add unrelated IDs as ambient capability tokens.
- State model-visible diagnostics, logs, tool descriptions, and instructions directly. The execution context is already clear; do not repeat `Code Mode` or `CodeMode` unless the distinction is necessary.
- When interpreter behavior or support changes, update `interpreter-support.md` and direct tests in the same PR.

## Compiler And IR

- `src/ir.ts` owns the versioned data-only program representation. The compiler and the runtime both
  depend on it; the compiler must not depend on the interpreter, the host, or persistence, so keep it
  to source in and IR or a `CompileError` out.
- Static language rules and compile-time metadata, such as rejected syntax and the durable names a
  program declares, belong in the compiler. Runtime checks remain only where a rule cannot be decided
  statically, such as computed mutator names.
- Persisted IR enters execution through `decodeProgram` only. Extend that boundary when the IR
  version changes rather than validating program shape inside the interpreter.

## Durable Values

- Every language value must be durable across execution, restart, fork, and revert: `null`, booleans, finite numbers, strings, immutable arrays, string-keyed records, durable functions, and explicitly modeled host references. Do not reintroduce `Date`, `RegExp`, `Map`, `Set`, `URL`, or `URLSearchParams` as language values; helpers may use them internally but must return plain data.
- Durable functions keep their versioned compiled body, their exact captures bound when the execution saves, and static tool paths that are resolved and authorized again at call time. A saved closure must never resolve a notebook name later, so free identifiers are either host globals or captured values.
- Enforce depth and size limits while values are built, not at the host's commit, so an invalid durable value fails the execution that produced it.
- A value that cannot be represented durably, such as a live tool handle, is rejected with a direct diagnostic rather than weakened.
- Encoding normalizes what JSON cannot represent, currently array holes and `undefined` values to `null`, `-0` to `0`, and record keys whose value is `undefined` by dropping them, so a fresh in-memory value and its persisted round trip behave identically.
- A stored value that fails to decode is quarantined in its own binding, along with anything that references it, and reports a precise diagnostic when read. Never suggest redeclaring an append-only name: the fix is a new name or a revert.
- Durable names are reserved against `src/globals.ts`, the one list the runtime builds its global scope from. Add a new global there rather than in the runtime alone, or a permanent notebook name could shadow it.

## Materialized Values

`src/limits.ts` owns the one ceiling on a single value: `MAX_COLLECTION_ITEMS` items in an array or
record and `MAX_STRING_LENGTH` characters in a string. The execution deadline only interrupts the
interpreter between steps, so any operation whose result size is implied by its arguments must check
the size before the native allocation or the synchronous O(n) work, not after. Do not defend against
this with yielding loops. Array methods may treat the item limit as an invariant only while every
path that introduces an array — construction, `Array.from`, spreads, growing methods, and the tool
boundary copy — keeps enforcing it. Report a violation as `InvalidDataValue` that a program catches
as a `RangeError`.

## Regular Expressions

Pattern matching is unavailable, and no partial or heuristically restricted form of it is acceptable. The only engine reachable here backtracks, so a pattern such as `^a*a*a*a*a*$` blocks the host's event loop where the execution deadline cannot interrupt it, and restricting the accepted syntax does not enumerate the pathological cases. Reintroduce matching only with an engine whose cost is bounded by input length.

## OpenAPI

- Generate an operation only when its transport semantics are supported; otherwise return a precise `skipped` reason.
- Never guess parameter serialization or malformed security semantics. Unsupported serialization is skipped and malformed security fails closed.
- Render unresolved schema constructs as `unknown`, never as invented TypeScript names.
- Keep network reads bounded and map expected encoding, transport, and decoding failures to model-safe `ToolError` values.
- Test supported behavior directly; do not reproduce adapter algorithms in tests.

## Future Design Notes

- If a captured user-visible output channel returns (an earlier `output.text`/`output.file`/`output.image` API was removed from v1), keep `output` as its name, distinct from the program return value: `return` stays the structured result for the model, while `output.*` describes artifacts the host may render into a conversation or UI after execution. Keep this host-neutral and let applications decide how captured output is delivered. In v1, hosts collect media host-side (outside CodeMode) instead.
- Improve the failure taxonomy. Distinguish parse/compile mistakes, unsupported syntax, user-thrown errors, invalid returned data, tool refusal, tool internal failure, timeout, and genuine runtime defects so agents can recover accurately instead of treating everything as a generic execution failure.
- Report host failure messages and underlying causes rather than replacing them with generic diagnostics. Preserve interruption behavior.
- Think deliberately about richer binary boundaries before allowing `Blob`, `File`, `ArrayBuffer`, streams, or typed arrays beyond today's JSON-like values. If CodeMode supports binary tool args/results, use explicit tagged data shapes and clear size limits rather than relying on ambient runtime serialization.
- Keep host capabilities explicit. Globals such as `fetch`, `crypto`, filesystem handles, extra modules, or network clients should be opt-in runtime capabilities with obvious policy defaults, not ambient authority. Default to unavailable unless a host deliberately provides the capability.
- If `fetch` is added, model it as a host-provided outbound capability with policy controls: allowed origins, methods, headers, response size, timeout, and whether response bodies may be returned, emitted, or only summarized through a tool.
