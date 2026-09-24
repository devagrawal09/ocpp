import type { CommandApi } from "@ocpp/client/effect/api"
import type { PromptInput } from "@ocpp/schema/prompt-input"
import type { Session } from "@ocpp/schema/session"
import type { SessionInbox } from "@ocpp/schema/session-inbox"
import type { Effect } from "effect"
import type { Transform } from "./registration.js"

export interface CommandInvocation {
  readonly sessionID: Session.ID
  readonly prompt: PromptInput.Prompt
  readonly delivery: SessionInbox.Delivery
}

export interface CommandDefinition {
  readonly name: string
  readonly description?: string
  readonly execute: (input: CommandInvocation) => Effect.Effect<void, unknown>
}

export interface CommandDraft {
  add(definition: CommandDefinition): void
}

export interface CommandDomain extends Pick<CommandApi<unknown>, "list"> {
  readonly transform: Transform<CommandDraft>
  readonly reload: () => Effect.Effect<void>
}
