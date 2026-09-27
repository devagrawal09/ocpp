import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@ocpp/schema/agent"
import { Command } from "@ocpp/schema/command"
import { Connection } from "@ocpp/schema/connection"
import { Credential } from "@ocpp/schema/credential"
import { Integration } from "@ocpp/schema/integration"
import { Location } from "@ocpp/schema/location"
import { Mcp } from "@ocpp/schema/mcp"
import { Model } from "@ocpp/schema/model"
import { PersistentPty } from "@ocpp/schema/persistent-pty"
import { Provider } from "@ocpp/schema/provider"
import { Reference } from "@ocpp/schema/reference"
import { Skill } from "@ocpp/schema/skill"
import { Vcs } from "@ocpp/schema/vcs"
import { WebSearch } from "@ocpp/schema/websearch"

const Plugin = await import("../src/effect/index")
const PromisePlugin = await import("../src/promise/index")

test.each([
  ["effect", Plugin],
  ["promise", PromisePlugin],
])("%s entrypoint exposes its canonical Schema contracts", (_name, entrypoint) => {
  expect(entrypoint.Agent).toBe(Agent)
  expect(entrypoint.Command).toBe(Command)
  expect(entrypoint.Connection).toBe(Connection)
  expect(entrypoint.Credential).toBe(Credential)
  expect(entrypoint.Integration).toBe(Integration)
  expect(entrypoint.Location).toBe(Location)
  expect(entrypoint.Mcp).toBe(Mcp)
  expect(entrypoint.Model).toBe(Model)
  expect(entrypoint.PersistentPty).toBe(PersistentPty)
  expect(entrypoint.Provider).toBe(Provider)
  expect(entrypoint.Reference).toBe(Reference)
  expect(entrypoint.Skill).toBe(Skill)
  expect(entrypoint.Vcs).toBe(Vcs)
  expect(entrypoint.WebSearch).toBe(WebSearch)
  expect(Object.keys(entrypoint).sort()).toEqual([
    "Agent",
    "Command",
    "Connection",
    "Credential",
    "Integration",
    "Location",
    "Mcp",
    "Model",
    "PersistentPty",
    "Plugin",
    "Provider",
    "Reference",
    "Skill",
    "Vcs",
    "WebSearch",
  ])
})

test.each([
  ["effect", Plugin.Plugin.define({ id: "svn", vcs: { markers: [".svn"] }, effect: () => Effect.void })],
  ["promise", PromisePlugin.Plugin.define({ id: "svn", vcs: { markers: [".svn"] }, setup() {} })],
])("%s plugin definitions retain repository markers", (_name, plugin) => {
  expect(plugin.vcs).toEqual({ markers: [".svn"] })
})
