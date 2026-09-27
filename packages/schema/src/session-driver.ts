export * as SessionDriver from "./session-driver.js"

import { Schema } from "effect"
import { ExternalSession } from "./external-session.js"
import type { Model } from "./model.js"

/**
 * What runs a Session: the OC++ runner (`ocpp`), or a vendor agent. A vendor model reference such as
 * `claude/sonnet` selects that vendor, so choosing a driver is choosing a model.
 */
export const ID = Schema.Literals(["ocpp", ...ExternalSession.Provider.literals]).annotate({
  identifier: "SessionDriver.ID",
})
export type ID = typeof ID.Type

/**
 * The capabilities a vendor-driven subagent runs with. `ocpp` offers only OC++'s full `execute` under the OC++
 * system prompt; `native` keeps the vendor's own tools and prompt and adds OC++'s tools over MCP.
 */
export const Harness = Schema.Literals(["ocpp", "native"]).annotate({ identifier: "SessionDriver.Harness" })
export type Harness = typeof Harness.Type

/** A vendor driver as offered for selection. `available` means its CLI and login are ready. */
export const Info = Schema.Struct({
  id: ExternalSession.Provider,
  name: Schema.String,
  available: Schema.Boolean,
  /** The configured default model. */
  model: Schema.String,
  models: Schema.Array(Schema.String),
  /** Reasoning efforts, selected as model variants. */
  variants: Schema.Array(Schema.String),
}).annotate({ identifier: "SessionDriver.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const names: Record<ExternalSession.Provider, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" }

const vendor = Schema.is(ExternalSession.Provider)

export function of(model: Pick<Model.Ref, "providerID"> | undefined): ID {
  const provider = model?.providerID
  return vendor(provider) ? provider : "ocpp"
}
