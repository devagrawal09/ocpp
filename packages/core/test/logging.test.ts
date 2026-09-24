import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@ocpp/util/global"
import { Logging } from "@ocpp/util/observability/logging"

describe("Logging", () => {
  test("uses a local-specific log file for local installs", () => {
    expect(Logging.file(true, "local")).toBe(path.join(Global.Path.log, "ocpp-local.log"))
  })

  test("keeps non-local installs on the default log file", () => {
    expect(Logging.file(false, "next")).toBe(path.join(Global.Path.log, "ocpp.log"))
  })
})
