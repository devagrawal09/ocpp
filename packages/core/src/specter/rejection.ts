export * as SpecterRejection from "./rejection.js"

import { SpecterCommandRejectedError } from "@ocpp/runtime"

/** The reason a runtime Command was rejected for, or undefined for any other failure. */
export const reason = (error: unknown) =>
  error instanceof SpecterCommandRejectedError
    ? error.cause instanceof Error
      ? error.cause.message
      : String(error.cause)
    : undefined

/** Rejections that mean the Session a Command addressed is not there: never created, or deleted. */
export const isMissingSession = (error: unknown) => {
  const why = reason(error)
  return why === "Session not found" || why === "Session deleted"
}
