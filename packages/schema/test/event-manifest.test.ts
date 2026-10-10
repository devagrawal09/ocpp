import { describe, expect, test } from "bun:test"
import {
  Agent,
  Config,
  Credential,
  FileSystem,
  Form,
  Integration,
  PersistentPty,
  Project,
  Reference,
  Session,
  Workspace,
} from "../src/index.js"
import { EventManifest } from "../src/event-manifest.js"
import { CredentialFact } from "../src/credential-fact.js"
import { KeyValueFact } from "../src/key-value-fact.js"
import { ProjectFact } from "../src/project-fact.js"
import { SessionFact } from "../src/session-fact.js"
import { FileSystemV1 } from "../src/filesystem-v1.js"
import { IdeEvent } from "../src/ide-event.js"
import { McpEvent } from "../src/mcp-event.js"
import { Plugin } from "../src/plugin.js"
import { SessionEvent } from "../src/session-event.js"
import { SessionID } from "../src/session-id.js"
import { SessionMessage } from "../src/session-message.js"
import { WorkspaceEvent } from "../src/workspace-event.js"

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    expect(EventManifest.ServerDefinitions).toContain(Agent.Event.Updated)
    expect(EventManifest.ServerDefinitions.filter((definition) => definition.type === "agent-updated")).toEqual([
      Agent.Event.Updated,
    ])
    expect(EventManifest.Definitions).toContain(Agent.Event.Updated)
    expect(EventManifest.Definitions.filter((definition) => definition.type === "agent-updated")).toEqual([
      Agent.Event.Updated,
    ])
    expect(Array.from(EventManifest.ByType.keys())).toEqual(
      Array.from(new Set(EventManifest.Definitions.map((definition) => definition.type))),
    )
    expect(EventManifest.ByType.get("agent-updated")).toBe(Agent.Event.Updated)
    expect(EventManifest.ByType.get("plugin-updated")).toBe(Plugin.Event.Updated)
    expect(EventManifest.Server.get("mcp-status-changed")).toBe(McpEvent.StatusChanged)
    expect(EventManifest.Server.get("mcp-resources-changed")).toBe(McpEvent.ResourcesChanged)
    expect(EventManifest.Server.get("session-created")).toBe(SessionEvent.Created)
    expect(EventManifest.Server.get("session-deleted")).toBe(SessionEvent.Deleted)
    expect(EventManifest.Server.get("project-updated")).toBe(Project.Event.Updated)
    expect(EventManifest.Server.has("mcp-tools-changed")).toBe(false)
    expect(EventManifest.Server.has("question.asked")).toBe(false)
    expect(EventManifest.Server.has("question.replied")).toBe(false)
    expect(EventManifest.Server.has("question.rejected")).toBe(false)
    expect(Agent.Event.Updated.durable).toBeUndefined()
    expect(EventManifest.Durable.has("agent-updated")).toBe(false)
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.ByType.get("session-step-settled")).toBe(SessionEvent.Step.Settled)
    expect(EventManifest.ByType.get("agent-updated")).toBe(Agent.Event.Updated)
    expect(EventManifest.ByType.get("project-updated")).toBe(Project.Event.Updated)
    expect(Agent.Event.Definitions).toEqual([Agent.Event.Updated])
    expect(Credential.Event.Definitions).toEqual([Credential.Event.Updated, Credential.Event.Switched])
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(Config.Event.Definitions).toEqual([Config.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Changed])
    expect(FileSystemV1.Event.Definitions).toEqual([FileSystemV1.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated])
    expect(PersistentPty.Event.Definitions).toEqual([PersistentPty.Event.Added, PersistentPty.Event.Removed])
    expect(Form.Event.Definitions).toEqual([Form.Event.Created, Form.Event.Replied, Form.Event.Cancelled])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(Plugin.Event.Definitions).toEqual([Plugin.Event.Added, Plugin.Event.Updated])
    expect(McpEvent.Definitions).toEqual([McpEvent.ToolsChanged, McpEvent.ResourcesChanged, McpEvent.StatusChanged])
    expect(EventManifest.ByType.has("mcp-browser-open-failed")).toBe(false)
    expect(EventManifest.ByType.has("ide-installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    expect(EventManifest.Durable.get("session-step-settled")).toBe(SessionEvent.Step.Settled)
  })

  test("keeps credential events public, canonical, and ephemeral", () => {
    const credentialID = Credential.ID.make("cred_test")
    const integrationID = Integration.ID.make("integration_test")

    for (const definition of Credential.Event.Definitions) {
      expect(EventManifest.ServerDefinitions).toContain(definition)
      expect(EventManifest.Definitions).toContain(definition)
      expect(EventManifest.Server.get(definition.type)).toBe(definition)
      expect(EventManifest.ByType.get(definition.type)).toBe(definition)
      expect(definition.durability).toBe("ephemeral")
      expect(EventManifest.Durable.has(definition.type)).toBe(false)
    }

    expect(Credential.Event.Updated.data.make({})).toEqual({})
    expect(Credential.Event.Switched.data.make({ integrationID, credentialID })).toEqual({
      integrationID,
      credentialID,
    })
    expect(Credential.Event.Switched.data.make({ integrationID, credentialID: null })).toEqual({
      integrationID,
      credentialID: null,
    })
    expect(EventManifest.Server.has("credential-created")).toBe(false)
    expect(EventManifest.Server.has("credential-activated")).toBe(false)
    expect(EventManifest.Server.has("credential-deleted")).toBe(false)
    expect(EventManifest.Server.has("integration-connection-updated")).toBe(false)
    expect(EventManifest.ByType.has("integration-connection-updated")).toBe(false)
  })

  test("derives durable definitions from explicit definition durability", () => {
    expect(Array.from(EventManifest.Durable.keys()).toSorted()).toEqual(
      [
        "session-created",
        "session-external-bound",
        "session-external-linked",
        "session-external-checkpointed",
        "session-deleted",
        "session-agent-selected",
        "session-model-selected",
        "session-tools-selected",
        "session-moved",
        "session-renamed",
        "session-viewed",
        "session-message-content-updated",
        "session-usage-recorded",
        "session-forked",
        "session-inbox-delivered",
        "session-inbox-enqueued",
        "session-inbox-cancelled",
        "session-inbox-delivery-changed",
        "session-inbox-held",
        "session-execution-started",
        "session-execution-continued",
        "session-execution-settled",
        "session-instructions-updated",
        "session-invocation-started",
        "session-synthetic",
        "session-displayed",
        "session-skill-activated",
        "session-shell-started",
        "session-shell-settled",
        "session-step-started",
        "session-step-streamed",
        "session-step-settled",
        "session-block-recorded",
        "session-tool-input-failed",
        "session-tool-requested",
        "session-tool-settled",
        "session-codemode-started",
        "session-codemode-completed",
        "session-codemode-failed",
        "session-compaction-started",
        "session-compaction-ended",
        "session-compaction-failed",
        "session-revert-staged",
        "session-revert-cleared",
        "session-revert-committed",
        "worktree-resolved",
        // Internal facts: recorded in Specter's log, projected into OC++'s tables, never sent to clients.
        "project-created",
        "project-vcs-changed",
        "project-relocated",
        "project-edited",
        "worktree-recorded",
        "worktree-removed",
        "workspace-created",
        "workspace-bound",
        "workspace-used",
        "workspace-destroyed",
        "session-imported",
        "session-instruction-blobs-stored",
        "session-instruction-entry-set",
        "session-instruction-entry-removed",
        "session-codemode-execution-admitted",
        "session-codemode-execution-started",
        "session-codemode-execution-resumed",
        "session-codemode-execution-settled",
        "session-codemode-execution-discarded",
        "session-codemode-call-scheduled",
        "session-codemode-call-progressed",
        "session-codemode-call-settled",
        "session-codemode-command-defined",
        "session-codemode-command-removed",
        "session-codemode-event-defined",
        "session-codemode-event-toggled",
        "session-codemode-event-removed",
        "session-codemode-event-planned",
        "session-codemode-event-fired",
        "session-codemode-event-skipped",
        "session-background-recorded",
        "session-background-terminal",
        "session-background-completed",
        "credential-created",
        "credential-activated",
        "credential-relabeled",
        "credential-rotated",
        "credential-removed",
        "kv-stored",
        "kv-removed",
      ].toSorted(),
    )
    for (const definition of [
      ...ProjectFact.Definitions,
      ...SessionFact.Definitions,
      ...CredentialFact.Definitions,
      ...KeyValueFact.Definitions,
    ])
      expect(EventManifest.Server.has(definition.type)).toBe(false)
    expect(SessionEvent.DurableDefinitions).toEqual([
      ...SessionEvent.Definitions.filter((definition) => definition.durability === "durable"),
      SessionEvent.UsageRecorded,
    ])
    expect(SessionEvent.UsageRecorded.durability).toBe("durable")
    expect(EventManifest.Durable.get("session-usage-recorded")).toBe(SessionEvent.UsageRecorded)
    expect(SessionEvent.Definitions).not.toContain(SessionEvent.UsageRecorded)
    expect(EventManifest.Definitions).not.toContain(SessionEvent.UsageRecorded)
    expect(EventManifest.ServerDefinitions).not.toContain(SessionEvent.UsageRecorded)
    expect(EventManifest.ByType.has("session-usage-recorded")).toBe(false)
    expect(SessionEvent.UsageUpdated.durability).toBe("ephemeral")
    expect(SessionEvent.Compaction.Delta.durability).toBe("ephemeral")
    expect(SessionEvent.Tool.Progress.durability).toBe("ephemeral")
    expect(SessionEvent.CodeMode.Progress.durability).toBe("ephemeral")
    expect(EventManifest.Server.get("session-codemode-progress")).toBe(SessionEvent.CodeMode.Progress)
    expect(EventManifest.Server.get("session-tool-progress")).toBe(SessionEvent.Tool.Progress)
    expect(EventManifest.Durable.has("session-compaction-delta")).toBe(false)
    expect(EventManifest.ServerDefinitions).toContain(SessionEvent.UsageUpdated)
    expect(EventManifest.Definitions.every((definition) => definition.durability !== undefined)).toBe(true)
  })

  test("uses the current Session skill event", () => {
    expect(EventManifest.Durable.get("session-skill-activated")).toBe(SessionEvent.Skill.Activated)
    expect(EventManifest.ByType.get("session-skill-activated")).toBe(SessionEvent.Skill.Activated)
  })

  test("keeps simplified session block and tool payloads", () => {
    const sessionID = SessionID.make("ses_test")
    const assistantMessageID = SessionMessage.ID.make("msg_test")
    const block = SessionEvent.Block.Recorded.data.make({
      sessionID,
      assistantMessageID,
      kind: "reasoning",
      ordinal: 0,
      text: "thought",
      state: { signature: "sig" },
    })
    const tool = SessionEvent.Tool.Requested.data.make({
      sessionID,
      assistantMessageID,
      id: "call_test",
      name: "read",
      input: {},
      executed: true,
      state: { itemId: "item_test" },
    })

    expect(block).not.toHaveProperty("reasoningID")
    expect(block).not.toHaveProperty("providerMetadata")
    expect(tool).not.toHaveProperty("tool")
    expect(tool).not.toHaveProperty("provider")
  })

  test("streams blocks and tool input live only", () => {
    for (const definition of [
      SessionEvent.Block.Started,
      SessionEvent.Block.Delta,
      SessionEvent.Tool.Input.Started,
      SessionEvent.Tool.Input.Delta,
    ]) {
      expect(definition.durability).toBe("ephemeral")
      expect(EventManifest.Server.get(definition.type)).toBe(definition)
    }
  })

  test("keeps current session deletion minimal", () => {
    const sessionID = SessionID.make("ses_test")

    expect(SessionEvent.Deleted.data.make({ sessionID })).toEqual({ sessionID })
    expect(SessionEvent.Deleted.durable).toEqual({ aggregate: "sessionID" })
  })
})
