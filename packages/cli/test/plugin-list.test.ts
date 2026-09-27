import { expect, test } from "bun:test"
import { EOL } from "node:os"
import { format } from "../src/commands/handlers/plugin/list"

test("formats server plugins without builtins", () => {
  expect(
    format([
      { id: "ocpp.agent", source: { type: "builtin" }, status: "active" },
      { id: "acme.plugin", source: { type: "package", package: "acme-plugin@1.0.0" }, status: "active" },
      { source: { type: "package", package: "broken-plugin" }, status: "failed", error: "broken" },
    ]),
  ).toBe(["acme.plugin (active)", "broken-plugin (failed)"].join(EOL))
})

test("includes builtins when requested", () => {
  expect(format([{ id: "ocpp.agent", source: { type: "builtin" }, status: "active" }], true)).toBe(
    "ocpp.agent (active)",
  )
})
