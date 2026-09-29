export * as ToolSessionTools from "./session-tools.js"

import type { Tool } from "@ocpp/schema/tool"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Context, Layer, type Schema } from "effect"
import type { SessionSchema } from "../session/schema.js"

/** Tools one caller lends a Session for a while, such as a subagent call's handles and machine input. */
export interface Registration {
  readonly token: symbol
  readonly tools: ReadonlyMap<string, Tool.Info>
  readonly input?: Schema.Json
}

export interface Interface {
  /**
   * Registrations by Session, shared by every Location: a caller registers in its own Location, and a child
   * Session placed in another Location still finds them there.
   */
  readonly bySession: Map<SessionSchema.ID, Array<Registration>>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/ToolSessionTools") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.sync(Service, () => Service.of({ bySession: new Map() })),
  deps: [],
})
