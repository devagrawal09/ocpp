import { expect, test } from "bun:test"

import { DurableEventManifest } from "@ocpp/schema/durable-event-manifest"

import { sessionEventDefinitions } from "../src/events.ts"

test("every durable OC++ session event becomes a Specter event definition", async () => {
  expect(sessionEventDefinitions.length).toBeGreaterThan(0)
  const names = sessionEventDefinitions.map((definition) => definition.type)
  expect(new Set(names).size).toBe(names.length)
  expect(names).toContain("session-inbox-enqueued")
  expect(names.every((name) => !name.includes("."))).toBe(true)
})

test("an OC++ fact keeps its name in the log", () => {
  const names = new Set(sessionEventDefinitions.map((definition) => definition.type))
  expect(DurableEventManifest.Definitions.filter((definition) => !names.has(definition.type))).toEqual([])
})

test("payload decoding goes through the Standard Schema", async () => {
  const definition = sessionEventDefinitions.find((d) => d.type === "session-inbox-enqueued")
  if (!definition) throw new Error("session-inbox-enqueued definition missing")
  await expect(definition.decode({})).rejects.toBeDefined()
})
