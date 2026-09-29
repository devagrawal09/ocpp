import { Delegation } from "@ocpp/schema/delegation"
import { Effect } from "effect"
import type { Bus } from "../../bus.js"
import { SessionEvent } from "../event.js"
import type { SessionSchema } from "../schema.js"
import type { SessionStore } from "../store.js"

/** Fails tool calls a previous process left streaming or running, before a drain continues the Session. */
export const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
  store: SessionStore.Interface,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
) {
  for (const message of yield* store.context(sessionID)) {
    if (message.type !== "assistant") continue
    for (const tool of message.content) {
      if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
      const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
      const childID =
        Delegation.isTool(tool.name) && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
      yield* bus.publish(SessionEvent.Tool.Failed, {
        sessionID,
        assistantMessageID: message.id,
        id: tool.id,
        error: {
          type: "aborted",
          message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
        },
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
        executed: tool.executed === true,
      })
    }
  }
})
