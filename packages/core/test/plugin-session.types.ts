import type { Context } from "@ocpp/plugin/effect/plugin"
import type { SessionDomain } from "@ocpp/plugin/promise/session"
import { Session } from "@ocpp/schema/session"
import { SessionMessage } from "@ocpp/schema/session-message"
import { Effect } from "effect"

export function effectPrompt(context: Context) {
  context.session.hook("prompt", (event) =>
    Effect.sync(() => {
      event.prompt.files ??= []
      event.prompt.files.push({ uri: "file:///policy.md" })
      event.delivery = "queue"
      // @ts-expect-error Admission identity cannot be rewritten.
      event.sessionID = Session.ID.make("ses_other")
    }),
  )
  // @ts-expect-error Prompt admission has no resolved model to filter by provider.
  context.session.hook("prompt", () => Effect.void, { providerID: "openai" })
  context.session.hook("context", () => Effect.void, { providerID: "openai" })
}

export function promisePrompt(session: SessionDomain) {
  session.hook("prompt", (event) => {
    event.prompt.text = "Prepared"
    event.metadata = { source: "plugin" }
    // @ts-expect-error Admission identity cannot be rewritten.
    event.messageID = SessionMessage.ID.make("msg_other")
  })
  // @ts-expect-error Prompt admission has no resolved model to filter by provider.
  session.hook("prompt", () => {}, { providerID: "openai" })
  session.hook("context", () => {}, { providerID: "openai" })
}
