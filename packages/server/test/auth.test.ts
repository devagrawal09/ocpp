import { expect, test } from "bun:test"
import { ServerAuth } from "@ocpp/server/auth"
import { Option, Redacted } from "effect"

test("accepts only the fixed ocpp username", () => {
  const config = { password: Option.some("secret"), username: "ocpp" }
  expect(ServerAuth.authorized({ username: "ocpp", password: Redacted.make("secret") }, config)).toBe(true)
  expect(ServerAuth.authorized({ username: "custom", password: Redacted.make("secret") }, config)).toBe(false)
})
