export * as SpecterSessions from "./index.js"

import type { LayerNode } from "@ocpp/util/effect/layer-node"
import { SessionExecution } from "../session/execution.js"
import { SessionInbox } from "../session/inbox.js"
import { SpecterSessionExecution } from "./session-execution.js"
import { SpecterSessionInbox } from "./session-inbox.js"

/**
 * The switch: these replacements run every Session on the embedded Specter runtime instead of OC++'s
 * own inbox, run coordinator and runner. The Session facade, HTTP handlers and projections are
 * unchanged; they see the runtime's events on the Bus.
 */
export const replacements = [
  [SessionInbox.node, SpecterSessionInbox.node],
  [SessionExecution.node, SpecterSessionExecution.node],
] as const satisfies LayerNode.Replacements
