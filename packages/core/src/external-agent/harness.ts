export * as ExternalAgentHarness from "./harness.js"

import { Context, type Effect } from "effect"
import type { DriveInbox } from "@ocpp/session-runtime"
import type { AgentNotFoundError, MessageDecodeError, StepFailedError } from "../session/error.js"
import type { SessionInbox } from "../session/inbox.js"
import type { DrainResult } from "../session/runner/index.js"
import type { SessionSchema } from "../session/schema.js"

export interface Interface {
  /**
   * Drives a vendor Session through durable input: delivers promoted inbox items to the vendor, projects its
   * events, and keeps the vendor session going until it is idle with no Code Mode execution still owing a
   * completion notification.
   */
  readonly drain: (input: {
    readonly sessionID: SessionSchema.ID
    readonly force: boolean
    readonly promotable?: SessionInbox.Promotable
    /** The Specter runtime's inbox for this execution: what delivers next, and delivering it. */
    readonly inbox: DriveInbox
  }) => Effect.Effect<DrainResult, StepFailedError | AgentNotFoundError | MessageDecodeError>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/ExternalAgentHarness") {}
