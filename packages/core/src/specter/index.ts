export * as SpecterSessions from "./index.js"

import type { LayerNode } from "@ocpp/util/effect/layer-node"
import { SessionExecution } from "../session/execution.js"
import { SessionInbox } from "../session/inbox.js"
import { SpecterSessionExecution } from "./session-execution.js"
import { SpecterSessionInbox } from "./session-inbox.js"

/**
 * Every Session runs on the embedded Specter runtime: AppNodeBuilder binds the inbox and execution nodes to
 * the runtime's. A composition that must not run OC++'s steps replaces `SpecterStepHost.node` instead.
 */
export const bindings = [
  [SessionInbox.node, SpecterSessionInbox.node],
  [SessionExecution.node, SpecterSessionExecution.node],
] as const satisfies LayerNode.Replacements
