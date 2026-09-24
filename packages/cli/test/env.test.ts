import { expect, test } from "bun:test"
import { Env } from "../src/env"

test("session environment omits server credentials", () => {
  const previousPassword = process.env.OCPP_PASSWORD
  const previousLegacyPassword = process.env.OCPP_SERVER_PASSWORD
  const previousValue = process.env.OCPP_SESSION_ENV_TEST
  process.env.OCPP_PASSWORD = "password"
  process.env.OCPP_SERVER_PASSWORD = "legacy"
  process.env.OCPP_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.OCPP_PASSWORD
  else process.env.OCPP_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.OCPP_SERVER_PASSWORD
  else process.env.OCPP_SERVER_PASSWORD = previousLegacyPassword
  if (previousValue === undefined) delete process.env.OCPP_SESSION_ENV_TEST
  else process.env.OCPP_SESSION_ENV_TEST = previousValue

  expect(environment.OCPP_PASSWORD).toBeUndefined()
  expect(environment.OCPP_SERVER_PASSWORD).toBeUndefined()
  expect(environment.OCPP_SESSION_ENV_TEST).toBe("included")
})
