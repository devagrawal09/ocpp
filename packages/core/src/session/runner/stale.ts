import { Delegation } from "@ocpp/schema/delegation"
import { Effect, Schema } from "effect"
import type { Bus } from "../../bus.js"
import type { SessionSchema } from "../schema.js"
import type { SessionStore } from "../store.js"

const encodeMetadata = Schema.encodeSync(Schema.Record(Schema.String, Schema.Json))

/**
 * Fails tool calls a previous process left streaming or running, before a drain continues the Session. Each goes
 * through the runtime's Command for the step the dead attempt left in flight; one the runtime refuses has been
 * settled already (by its own orphan reconciliation) or belongs to no step in flight.
 */
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
      const failure = {
        sessionID,
        assistantMessageID: message.id,
        id: tool.id,
        error: {
          type: "aborted",
          message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
        },
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata: encodeMetadata(metadata) } : {}),
        executed: tool.executed === true,
      }
      // A call still streaming its input was never requested: its input fails.
      yield* bus
        .command(
          tool.state.status === "streaming"
            ? { type: "failToolInput", payload: { ...failure, name: tool.name } }
            : { type: "settleToolCall", payload: failure },
        )
        .pipe(Effect.ignore)
    }
  }
})
