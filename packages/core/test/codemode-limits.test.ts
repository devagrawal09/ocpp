import { expect, test } from "bun:test"
import { limits } from "@ocpp/core/codemode/limits"

test("Code Mode executions have no fixed wall-clock deadline", () => {
  expect("timeoutMs" in limits).toBe(false)
})
