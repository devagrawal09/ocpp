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

export const collectionLimitMessage = (label: string, items: number) =>
  `${label} would hold ${items} items, over the ${MAX_COLLECTION_ITEMS}-item limit for one value.`

export const stringLimitMessage = (label: string, characters: number) =>
  `${label} would hold ${characters} characters, over the ${MAX_STRING_LENGTH}-character limit for one value.`
