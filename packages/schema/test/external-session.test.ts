import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "../src/config.js"
import { CredentialFact } from "../src/credential-fact.js"
import { Delegation } from "../src/delegation.js"
import { DurableEventManifest } from "../src/durable-event-manifest.js"
import { EventManifest } from "../src/event-manifest.js"
import { ExternalSession } from "../src/external-session.js"
import { KeyValueFact } from "../src/key-value-fact.js"
import { ProjectFact } from "../src/project-fact.js"
import { SessionFact } from "../src/session-fact.js"

test("external persistence facts are durable and internal; children use ordinary public Session events", () => {
  for (const event of ExternalSession.Definitions) {
    expect(DurableEventManifest.Durable.get(event.type)).toBe(event)
    expect(EventManifest.Server.has(event.type)).toBe(false)
  }
})
test("project, Session and credential persistence facts are durable and internal", () => {
  for (const event of [
    ...ProjectFact.Definitions,
    ...SessionFact.Definitions,
    ...CredentialFact.Definitions,
    ...KeyValueFact.Definitions,
  ]) {
    expect(DurableEventManifest.Durable.get(event.type)).toBe(event)
    expect(EventManifest.Server.has(event.type)).toBe(false)
  }
})
test("external model configuration has separate provider defaults and opt-out switches", () => {
  expect(
    Schema.decodeUnknownSync(Config.Info)({
      external_agents: {
        claude: { model: "sonnet", effort: "high" },
        codex: { enabled: false },
        pi: { model: "anthropic/claude-sonnet-4-6" },
      },
    }).external_agents,
  ).toMatchObject({ claude: { model: "sonnet" }, codex: { enabled: false } })
})
test("only canonical delegation tools receive child-session UI behavior", () => {
  expect(["subagent", "claude", "codex", "pi"].every(Delegation.isTool)).toBe(true)
  expect(["shell", "task", "claude_helper"].some(Delegation.isTool)).toBe(false)
})
