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
    expect(Array.from(EventManifest.Latest.keys())).toEqual(
      Array.from(new Set(EventManifest.Definitions.map((definition) => definition.type))),
    )
    expect(EventManifest.Latest.get("agent-updated")).toBe(Agent.Event.Updated)
    expect(EventManifest.Latest.get("plugin-updated")).toBe(Plugin.Event.Updated)
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
    expect(EventManifest.Latest.get("session-step-ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("agent-updated")).toBe(Agent.Event.Updated)
    expect(EventManifest.Latest.get("project-updated")).toBe(Project.Event.Updated)
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
    expect(EventManifest.Latest.has("mcp-browser-open-failed")).toBe(false)
    expect(EventManifest.Latest.has("ide-installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    expect(EventManifest.Durable.get("session-step-ended.1")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Durable.has("session-step-ended.2")).toBe(false)
  })

  test("keeps credential events public, canonical, and ephemeral", () => {
    const credentialID = Credential.ID.make("cred_test")
    const integrationID = Integration.ID.make("integration_test")

    for (const definition of Credential.Event.Definitions) {
      expect(EventManifest.ServerDefinitions).toContain(definition)
      expect(EventManifest.Definitions).toContain(definition)
      expect(EventManifest.Server.get(definition.type)).toBe(definition)
      expect(EventManifest.Latest.get(definition.type)).toBe(definition)
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
    expect(EventManifest.Server.has("credential.deleted")).toBe(false)
    expect(EventManifest.Server.has("integration.connection.updated")).toBe(false)
    expect(EventManifest.Latest.has("integration.connection.updated")).toBe(false)
  })

  test("derives durable definitions from explicit definition durability", () => {
    expect(Array.from(EventManifest.Durable.keys()).toSorted()).toEqual(
      [
        "session-created.1",
        "session-external-bound.1",
        "session-external-linked.1",
        "session-external-checkpointed.1",
        "session-deleted.2",
        "session-agent-selected.1",
        "session-model-selected.1",
        "session-tools-selected.1",
        "session-moved.1",
        "session-renamed.1",
        "session-viewed.1",
        "session-message-content-updated.1",
        "session-usage-recorded.1",
        "session-forked.2",
        "session-inbox-delivered.1",
        "session-inbox-enqueued.1",
        "session-inbox-cancelled.1",
        "session-inbox-delivery-changed.1",
        "session-execution-started.1",
        "session-execution-succeeded.1",
        "session-execution-failed.1",
        "session-execution-interrupted.1",
        "session-instructions-updated.2",
        "session-invocation-started.1",
        "session-synthetic.1",
        "session-displayed.1",
        "session-skill-activated.1",
        "session-shell-started.1",
        "session-shell-ended.1",
        "session-step-started.1",
        "session-step-streamed.1",
        "session-step-ended.1",
        "session-step-failed.1",
        "session-text-started.1",
        "session-text-ended.1",
        "session-tool-input-started.1",
        "session-tool-input-ended.1",
        "session-tool-called.1",
        "session-tool-success.2",
        "session-tool-failed.2",
        "session-codemode-started.1",
        "session-codemode-completed.1",
        "session-codemode-failed.1",
        "session-reasoning-started.1",
        "session-reasoning-ended.1",
        "session-retry-scheduled.1",
        "session-compaction-started.1",
        "session-compaction-ended.1",
        "session-compaction-failed.1",
        "session-revert-staged.1",
        "session-revert-cleared.1",
        "session-revert-committed.1",
        "worktree-resolved.1",
        // Internal facts: recorded in Specter's log, projected into OC++'s tables, never sent to clients.
        "project-created.1",
        "project-vcs-changed.1",
        "project-relocated.1",
        "project-edited.1",
        "worktree-recorded.1",
        "worktree-removed.1",
        "workspace-created.1",
        "workspace-bound.1",
        "workspace-used.1",
        "workspace-destroyed.1",
        "session-imported.1",
        "session-instruction-blobs-stored.1",
        "session-instruction-entry-set.1",
        "session-instruction-entry-removed.1",
        "session-codemode-execution-admitted.1",
        "session-codemode-execution-started.1",
        "session-codemode-execution-resumed.1",
        "session-codemode-execution-settled.1",
        "session-codemode-execution-discarded.1",
        "session-codemode-call-scheduled.1",
        "session-codemode-call-progressed.1",
        "session-codemode-call-settled.1",
        "session-codemode-command-defined.1",
        "session-codemode-command-removed.1",
        "session-codemode-event-defined.1",
        "session-codemode-event-toggled.1",
        "session-codemode-event-removed.1",
        "session-codemode-event-planned.1",
        "session-codemode-event-fired.1",
        "session-codemode-event-skipped.1",
        "session-background-recorded.1",
        "session-background-terminal.1",
        "session-background-completed.1",
        "credential-created.1",
        "credential-activated.1",
        "credential-relabeled.1",
        "credential-rotated.1",
        "credential-removed.1",
        "kv-stored.1",
        "kv-removed.1",
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
    expect(EventManifest.Durable.get("session-usage-recorded.1")).toBe(SessionEvent.UsageRecorded)
    expect(SessionEvent.Definitions).not.toContain(SessionEvent.UsageRecorded)
    expect(EventManifest.Definitions).not.toContain(SessionEvent.UsageRecorded)
    expect(EventManifest.ServerDefinitions).not.toContain(SessionEvent.UsageRecorded)
    expect(EventManifest.Latest.has("session-usage-recorded")).toBe(false)
    expect(SessionEvent.UsageUpdated.durability).toBe("ephemeral")
    expect(SessionEvent.Compaction.Delta.durability).toBe("ephemeral")
    expect(SessionEvent.Tool.Progress.durability).toBe("ephemeral")
    expect(SessionEvent.CodeMode.Progress.durability).toBe("ephemeral")
    expect(EventManifest.Server.get("session-codemode-progress")).toBe(SessionEvent.CodeMode.Progress)
    expect(EventManifest.Server.get("session-tool-progress")).toBe(SessionEvent.Tool.Progress)
    expect(EventManifest.Durable.has("session-compaction-delta.1")).toBe(false)
    expect(EventManifest.ServerDefinitions).toContain(SessionEvent.UsageUpdated)
    expect(EventManifest.Definitions.every((definition) => definition.durability !== undefined)).toBe(true)
  })

  test("uses the current Session skill event as durable version 1", () => {
    expect(EventManifest.Durable.get("session-skill-activated.1")).toBe(SessionEvent.Skill.Activated)
    expect(EventManifest.Latest.get("session-skill-activated")).toBe(SessionEvent.Skill.Activated)
  })

  test("keeps simplified session fragment and tool payloads on durable version 1", () => {
    const sessionID = SessionID.make("ses_test")
    const assistantMessageID = SessionMessage.ID.make("msg_test")
    const text = SessionEvent.Text.Started.data.make({ sessionID, assistantMessageID, ordinal: 0 })
    const reasoning = SessionEvent.Reasoning.Ended.data.make({
      sessionID,
      assistantMessageID,
      ordinal: 0,
      text: "thought",
      state: { signature: "sig" },
    })
    const tool = SessionEvent.Tool.Called.data.make({
      sessionID,
      assistantMessageID,
      id: "call_test",
      input: {},
      executed: true,
      state: { itemId: "item_test" },
    })

    expect(text).not.toHaveProperty("textID")
    expect(reasoning).not.toHaveProperty("reasoningID")
    expect(reasoning).not.toHaveProperty("providerMetadata")
    expect(tool).not.toHaveProperty("tool")
    expect(tool).not.toHaveProperty("provider")
    expect(SessionEvent.Text.Started.durable?.version).toBe(1)
    expect(SessionEvent.Tool.Called.durable?.version).toBe(1)
  })

  test("keeps current session deletion minimal", () => {
    const sessionID = SessionID.make("ses_test")

    expect(SessionEvent.Deleted.data.make({ sessionID })).toEqual({ sessionID })
    expect(SessionEvent.Deleted.durable?.version).toBe(2)
  })
})
