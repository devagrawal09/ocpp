/**
 * The ceiling on one materialized value. It is a safety limit, not a policy a host configures: an
 * execution deadline can only interrupt the interpreter between steps, so a single operation that
 * asks the host for four billion array slots or a gigabyte-long string would block or exhaust the
 * process before the deadline is ever observed. Every operation whose output size is known before
 * the work starts checks these numbers first, so the interpreter never hands a request that large
 * to a native allocation or to a synchronous O(n) copy.
 *
 * The numbers are far above normal composition over tool results and far below what one operation
 * needs to destabilize the host.
 */

/** Maximum elements in one array, and maximum keys in one record. */
export const MAX_COLLECTION_ITEMS = 1_000_000

/** Maximum UTF-16 code units in one string. */
export const MAX_STRING_LENGTH = 4_000_000

/**
 * Speculative look-ahead bounds. Before each top-level statement, the interpreter may propose the
 * tool calls the program makes next so a host can start read-only ones early. These cap the work one
 * proposal does up front, so look-ahead stays linear in the program however long it is.
 */

/** Maximum tool calls one look-ahead proposes. */
export const MAX_SPECULATIVE_LOOKAHEAD_CALLS = 16

/** Maximum top-level statements one look-ahead scans. */
export const MAX_SPECULATIVE_LOOKAHEAD_STATEMENTS = 64

/**
 * Maximum runs of concurrent tools, such as subagents, that one execution may hold without having called
 * `wait()` on them. A call over it is refused before it starts, so a loop cannot launch unbounded work, and
 * the count depends only on program order, so a replayed execution refuses the same call.
 */
export const MAX_UNWAITED_RUNS = 10

export const collectionLimitMessage = (label: string, items: number) =>
  `${label} would hold ${items} items, over the ${MAX_COLLECTION_ITEMS}-item limit for one value.`

export const stringLimitMessage = (label: string, characters: number) =>
  `${label} would hold ${characters} characters, over the ${MAX_STRING_LENGTH}-character limit for one value.`
