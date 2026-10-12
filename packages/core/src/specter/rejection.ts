export * as SpecterRejection from "./rejection.js"

import { SpecterCommandRejectedError, type RejectionCode } from "@ocpp/runtime"

/**
 * What a runtime Command was refused with: its code, one its Scenarios name (`RejectionCode`, derived from them), its
 * message and, for some, structured details.
 */
export type Rejection = SpecterCommandRejectedError<RejectionCode>["rejection"]

/**
 * The rejection a runtime Command was refused with, or undefined for any other failure. Specter rejects only with a
 * code the Command's Scenarios name, so the code is a `RejectionCode`.
 */
export const of = (error: unknown) =>
  error instanceof SpecterCommandRejectedError ? (error.rejection as Rejection) : undefined

/** The code a runtime Command was rejected with, or undefined for any other failure. */
export const code = (error: unknown) => of(error)?.code

/** Whether a runtime Command was rejected with one of `codes`. */
export const is =
  (...codes: ReadonlyArray<RejectionCode>) =>
  (error: unknown) => {
    const rejected = code(error)
    return rejected !== undefined && codes.includes(rejected)
  }

/** Rejections that mean the Session a Command addressed is not there: never created, or deleted. */
export const isMissingSession = is("session-not-found", "session-deleted")
