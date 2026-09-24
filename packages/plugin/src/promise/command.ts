import type { CommandApi } from "@ocpp/client/promise/api"
import type { PromptInput } from "@ocpp/schema/prompt-input"
import type { Session } from "@ocpp/schema/session"
import type { SessionInbox } from "@ocpp/schema/session-inbox"
import type { Transform } from "./registration.js"

export interface CommandInvocation {
  readonly sessionID: Session.ID
  readonly prompt: PromptInput.Prompt
  readonly delivery: SessionInbox.Delivery
}

export interface CommandDefinition {
  readonly name: string
  readonly description?: string
  readonly execute: (input: CommandInvocation) => Promise<void>
}

export interface CommandDraft {
  add(definition: CommandDefinition): void
}

export interface CommandDomain extends Pick<CommandApi, "list"> {
  readonly transform: Transform<CommandDraft>
  readonly reload: () => Promise<void>
}
