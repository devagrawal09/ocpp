// TODO: Keep additional network capabilities inside Schema and Protocol as the client grows; /effect must never import
// Core or Server. Preserve these datatype exports so internal model reorganizations do not require caller migrations.
import type { Effect } from "effect"

export * from "./generated/index"
export type {
  AgentApi,
  AppApi,
  CatalogApi,
  CommandApi,
  ConfigApi,
  EventApi,
  IntegrationApi,
  ModelApi,
  PluginApi,
  ProviderApi,
  ReferenceApi,
  WebSearchApi,
  SessionApi,
  SkillApi,
} from "./api.js"
export { Agent } from "@ocpp/schema/agent"
export { Command } from "@ocpp/schema/command"
export { Config } from "@ocpp/schema/config"
export { Credential } from "@ocpp/schema/credential"
export { Event } from "@ocpp/schema/event"
export { EventLog } from "@ocpp/schema/event-log"
export { FileSystem } from "@ocpp/schema/filesystem"
export { Form } from "@ocpp/schema/form"
export { Integration } from "@ocpp/schema/integration"
export { Location } from "@ocpp/schema/location"
export { Model } from "@ocpp/schema/model"
export { Permission } from "@ocpp/schema/permission"
export { PermissionSaved } from "@ocpp/schema/permission-saved"
export { Project } from "@ocpp/schema/project"
export { Worktree } from "@ocpp/schema/worktree"
export { Vcs } from "@ocpp/schema/vcs"
export { Provider } from "@ocpp/schema/provider"
export { Pty } from "@ocpp/schema/pty"
export { Question } from "@ocpp/schema/question"
export { Reference } from "@ocpp/schema/reference"
export { WebSearch } from "@ocpp/schema/websearch"
export { AbsolutePath, RelativePath } from "@ocpp/schema/schema"
export { Session } from "@ocpp/schema/session"
export { SessionInbox } from "@ocpp/schema/session-inbox"
export { SessionMessage } from "@ocpp/schema/session-message"
export { Skill } from "@ocpp/schema/skill"
export { Prompt } from "@ocpp/schema/prompt"
export { PromptInput } from "@ocpp/schema/prompt-input"
export type { OcppEvent } from "@ocpp/protocol/groups/event"
export type OcppClient = Effect.Success<ReturnType<typeof import("./generated/client").make>>
