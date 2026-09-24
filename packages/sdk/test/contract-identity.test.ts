import { expect, test } from "bun:test"
import { Location as CoreLocation } from "@ocpp/core/location"
import { SessionInbox as CoreSessionInbox } from "@ocpp/core/session/inbox"
import { SessionMessage as CoreSessionMessage } from "@ocpp/core/session/message"
import { Agent } from "@ocpp/schema/agent"
import { Config } from "@ocpp/schema/config"
import { Event } from "@ocpp/schema/event"
import { Location } from "@ocpp/schema/location"
import { Model } from "@ocpp/schema/model"
import { Project } from "@ocpp/schema/project"
import { Provider } from "@ocpp/schema/provider"
import { WebSearch } from "@ocpp/schema/websearch"
import { Session } from "@ocpp/schema/session"
import { SessionInbox } from "@ocpp/schema/session-inbox"
import { SessionMessage } from "@ocpp/schema/session-message"
import { Workspace } from "@ocpp/schema/workspace"
import { Worktree } from "@ocpp/schema/worktree"
import { Api } from "@ocpp/server/api"
import { ClientApi, groupNames, promiseOmitEndpoints } from "@ocpp/protocol/client"
import { compile, emitPromise } from "@ocpp/httpapi-codegen"

const SDK = await import("../src/index")
const CoreAgent = await import("@ocpp/core/agent")
const CoreModel = await import("@ocpp/core/model")
const CoreProject = await import("@ocpp/core/project")
const CoreSession = await import("@ocpp/core/session")
const CoreWorktree = await import("@ocpp/core/worktree")

test("re-exports canonical contracts directly from Schema", () => {
  expect(SDK.Agent).toBe(Agent)
  expect(SDK.Config).toBe(Config)
  expect(SDK.Event).toBe(Event)
  expect(SDK.Model).toBe(Model)
  expect(SDK.WebSearch).toBe(WebSearch)
  expect(SDK.Session).toBe(Session)
  expect(SDK.Worktree).toBe(Worktree)
  expect(SDK.Workspace).toBe(Workspace)
  expect(Object.keys(SDK).sort()).toEqual([
    "AbsolutePath",
    "Agent",
    "ClientError",
    "Command",
    "Config",
    "Credential",
    "Event",
    "FileSystem",
    "Integration",
    "Location",
    "Model",
    "Ocpp",
    "Permission",
    "PermissionSaved",
    "Project",
    "Prompt",
    "PromptInput",
    "Provider",
    "Pty",
    "Question",
    "Reference",
    "RelativePath",
    "Session",
    "SessionInbox",
    "SessionMessage",
    "Skill",
    "Tool",
    "WebSearch",
    "Workspace",
    "Worktree",
  ])
})

test("Core and Server reuse the authoritative Schema and Protocol values", () => {
  expect(CoreAgent.ID).toBe(Agent.ID)
  expect(CoreLocation.Ref).toBe(Location.Ref)
  expect(CoreModel.Ref).toBe(Model.Ref)
  expect(CoreSession.Info).toBe(Session.Info)
  expect(CoreProject.Current).toBe(Project.Current)
  expect(CoreWorktree.DirectoryUnavailableError).toBeDefined()
  expect(CoreWorktree.List).toBe(Worktree.List)
  expect(CoreWorktree.Info).toBe(Worktree.Info)
  expect(CoreSessionInbox.Item).toBe(SessionInbox.Item)
  expect(CoreSessionInbox.User).toBe(SessionInbox.User)
  expect(CoreSessionInbox.Synthetic).toBe(SessionInbox.Synthetic)
  expect(CoreSessionMessage.Info).toBe(SessionMessage.Info)
  expect(CoreSessionMessage.AssistantText).toBe(SessionMessage.AssistantText)
  expect(Api.groups["server.session"].identifier).toBe("server.session")
  expect(Api.groups["server.project"].identifier).toBe("server.project")
  expect(Object.keys(ClientApi.groups)).toEqual(Object.keys(Api.groups))
  expect(Session.ID.create()).toStartWith("ses_")
  expect(String(Project.ID.global)).toBe("global")
  expect(String(Provider.ID.anthropic)).toBe("anthropic")
  expect(Workspace.ID.create()).toStartWith("wrk_")
})

test("client and Server contracts generate identically", () => {
  const server = compile(Api, { groupNames, omitEndpoints: promiseOmitEndpoints })
  const client = compile(ClientApi, { groupNames, omitEndpoints: promiseOmitEndpoints })

  expect(emitPromise(client)).toEqual(emitPromise(server))
})
