import { NodeFileSystem } from "@effect/platform-node"
import { compile, emitEffectImported, emitEffectShape, emitPromise, write } from "@ocpp/httpapi-codegen"
import { ClientApi, effectOmitEndpoints, groupNames, promiseOmitEndpoints } from "@ocpp/protocol/client"
import { Agent } from "@ocpp/schema/agent"
import { Command } from "@ocpp/schema/command"
import { Config } from "@ocpp/schema/config"
import { Credential } from "@ocpp/schema/credential"
import { Event } from "@ocpp/schema/event"
import { EventLog } from "@ocpp/schema/event-log"
import { FileDiff } from "@ocpp/schema/file-diff"
import { FileSystem } from "@ocpp/schema/filesystem"
import { Form } from "@ocpp/schema/form"
import { InstructionEntry } from "@ocpp/schema/instruction-entry"
import { Integration } from "@ocpp/schema/integration"
import { Location } from "@ocpp/schema/location"
import { Mcp } from "@ocpp/schema/mcp"
import { Model } from "@ocpp/schema/model"
import { Permission } from "@ocpp/schema/permission"
import { PermissionSaved } from "@ocpp/schema/permission-saved"
import { Plugin } from "@ocpp/schema/plugin"
import { Project } from "@ocpp/schema/project"
import { Worktree } from "@ocpp/schema/worktree"
import { AgentAttachment, FileAttachment, Prompt, PromptMention } from "@ocpp/schema/prompt"
import { PromptInput } from "@ocpp/schema/prompt-input"
import { Provider } from "@ocpp/schema/provider"
import { Pty } from "@ocpp/schema/pty"
import { PtyTicket } from "@ocpp/schema/pty-ticket"
import { Question } from "@ocpp/schema/question"
import { Reference } from "@ocpp/schema/reference"
import { AbsolutePath, PositiveInt, RelativePath } from "@ocpp/schema/schema"
import { Session } from "@ocpp/schema/session"
import { SessionMessage } from "@ocpp/schema/session-message"
import { SessionInbox } from "@ocpp/schema/session-inbox"
import { Shell } from "@ocpp/schema/shell"
import { Skill } from "@ocpp/schema/skill"
import { Vcs } from "@ocpp/schema/vcs"
import { WebSearch } from "@ocpp/schema/websearch"
import { Workspace } from "@ocpp/schema/workspace"
import { Effect, Schema } from "effect"
import { fileURLToPath } from "url"

const promiseContract = compile(ClientApi, { groupNames, omitEndpoints: promiseOmitEndpoints })
const effectContract = compile(ClientApi, { groupNames, omitEndpoints: effectOmitEndpoints })
const effectTypeReferences = [
  ...namespaceTypes("Agent", "@ocpp/schema/agent", Agent),
  ...namespaceTypes("Command", "@ocpp/schema/command", Command),
  ...namespaceTypes("Config", "@ocpp/schema/config", Config),
  ...namespaceTypes("Credential", "@ocpp/schema/credential", Credential),
  ...namespaceTypes("Event", "@ocpp/schema/event", Event),
  ...namespaceTypes("EventLog", "@ocpp/schema/event-log", EventLog),
  ...namespaceTypes("FileDiff", "@ocpp/schema/file-diff", FileDiff),
  ...namespaceTypes("FileSystem", "@ocpp/schema/filesystem", FileSystem),
  ...namespaceTypes("Form", "@ocpp/schema/form", Form),
  ...namespaceTypes("InstructionEntry", "@ocpp/schema/instruction-entry", InstructionEntry),
  ...namespaceTypes("Integration", "@ocpp/schema/integration", Integration),
  ...namespaceTypes("Location", "@ocpp/schema/location", Location),
  ...namespaceTypes("Mcp", "@ocpp/schema/mcp", Mcp),
  ...namespaceTypes("Model", "@ocpp/schema/model", Model),
  ...namespaceTypes("Permission", "@ocpp/schema/permission", Permission),
  ...namespaceTypes("PermissionSaved", "@ocpp/schema/permission-saved", PermissionSaved),
  ...namespaceTypes("Plugin", "@ocpp/schema/plugin", Plugin),
  ...namespaceTypes("Project", "@ocpp/schema/project", Project),
  ...namespaceTypes("Worktree", "@ocpp/schema/worktree", Worktree),
  ...namespaceTypes("PromptInput", "@ocpp/schema/prompt-input", PromptInput),
  ...namespaceTypes("Provider", "@ocpp/schema/provider", Provider),
  ...namespaceTypes("Pty", "@ocpp/schema/pty", Pty),
  ...namespaceTypes("PtyTicket", "@ocpp/schema/pty-ticket", PtyTicket),
  ...namespaceTypes("Question", "@ocpp/schema/question", Question),
  ...namespaceTypes("Reference", "@ocpp/schema/reference", Reference),
  ...namespaceTypes("Session", "@ocpp/schema/session", Session),
  ...namespaceTypes("SessionMessage", "@ocpp/schema/session-message", SessionMessage),
  ...namespaceTypes("SessionInbox", "@ocpp/schema/session-inbox", SessionInbox),
  ...namespaceTypes("Shell", "@ocpp/schema/shell", Shell),
  ...namespaceTypes("Skill", "@ocpp/schema/skill", Skill),
  ...namespaceTypes("Vcs", "@ocpp/schema/vcs", Vcs),
  ...namespaceTypes("WebSearch", "@ocpp/schema/websearch", WebSearch),
  ...namespaceTypes("Workspace", "@ocpp/schema/workspace", Workspace),
  typeReference("Prompt", "@ocpp/schema/prompt", Prompt),
  typeReference("PromptMention", "@ocpp/schema/prompt", PromptMention),
  typeReference("FileAttachment", "@ocpp/schema/prompt", FileAttachment),
  typeReference("AgentAttachment", "@ocpp/schema/prompt", AgentAttachment),
  typeReference("AbsolutePath", "@ocpp/schema/schema", AbsolutePath),
  typeReference("PositiveInt", "@ocpp/schema/schema", PositiveInt),
  typeReference("RelativePath", "@ocpp/schema/schema", RelativePath),
]

await Effect.runPromise(
  Effect.all(
    [
      write(
        emitPromise(promiseContract, {
          mutableOutputs: true,
        }),
        fileURLToPath(new URL("../src/promise/generated", import.meta.url)),
      ),
      write(
        emitEffectImported(effectContract, {
          module: "../../contract",
          api: "ClientApi",
          shapeModule: "../api/api.js",
        }),
        fileURLToPath(new URL("../src/effect/generated", import.meta.url)),
      ),
      write(
        emitEffectShape(effectContract, {
          typeReferences: effectTypeReferences,
          outputTypes: {
            "event.subscribe": {
              name: "OcppEvent",
              import: 'import type { OcppEvent } from "@ocpp/protocol/groups/event"',
            },
          },
        }),
        fileURLToPath(new URL("../src/effect/api", import.meta.url)),
      ),
    ],
    { concurrency: 3, discard: true },
  ).pipe(Effect.provide(NodeFileSystem.layer)),
)

function namespaceTypes(namespace: string, module: string, values: object) {
  return Object.entries(values).flatMap(([name, schema]) =>
    Schema.isSchema(schema) ? [typeReference(`${namespace}.${name}`, module, schema)] : [],
  )
}

function typeReference(name: string, module: string, schema: Schema.Top) {
  return {
    schema,
    name,
    import: `import type { ${name.split(".")[0]} } from ${JSON.stringify(module)}`,
  }
}
