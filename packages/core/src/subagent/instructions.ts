export * as SubagentInstructions from "./instructions.js"

import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { ExternalAgentDrivers } from "../external-agent/drivers.js"
import { Instructions } from "../instructions/index.js"
import { SubagentTool } from "../tool/plugin/subagent.js"

// The Code Mode catalog shows only the first line of `tools.subagent`'s description, so how to start one is
// stated here.
const render = () =>
  [
    "Subagents work on a task in a child session. Start one with `tools.subagent`, passing a short `description`, the task as `message` and the child's tools as `tools`.",
    "A new child has no preset prompt and fresh context, so include everything it needs in `message`. It runs on your model and driver unless you pass `model` or `driver`. The child can call exactly the tools you pass: your own tools such as tools.read, whole namespaces such as tools.linear, and tool.define handles. Without `tools` it has none, only tools.submit_result when you pass an outputSchema.",
    "Pass `root` to run one in another existing directory, such as a separate git worktree.",
  ].join("\n")

const Driver = Schema.Struct({ id: Schema.String, name: Schema.String, model: Schema.String })
type Driver = typeof Driver.Type

const renderDrivers = (drivers: ReadonlyArray<Driver>) =>
  [
    "`tools.subagent` takes a `driver`: `ocpp` runs the child with the OC++ runner and a provider model; a vendor driver runs it with that vendor's agent and the user's own login, in the OC++ harness unless you pass `harness: \"native\"`. A new child takes this session's own driver.",
    "Ready vendor drivers:",
    ...drivers.map((driver) => `- ${driver.id}: ${driver.name}, default model ${driver.model}`),
  ].join("\n")

export interface Interface {
  /** Subagent guidance for a request whose Code Mode catalog holds these paths: none without `tools.subagent`. */
  readonly load: (catalog: ReadonlyArray<string>) => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/SubagentInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const drivers = yield* ExternalAgentDrivers.Service

    return Service.of({
      load: Effect.fn("SubagentInstructions.load")(function* (catalog) {
        const callable = catalog.includes(SubagentTool.name)
        const ready = callable
          ? (yield* drivers.list())
              .filter((driver) => driver.available)
              .map((driver) => ({ id: driver.id, name: driver.name, model: driver.model }))
          : []
        const guidance = Instructions.make<ReadonlyArray<Driver>>({
          key: Instructions.Key.make("core/subagent-drivers"),
          codec: Schema.toCodecJson(Schema.Array(Driver)),
          read: Effect.succeed(ready.length === 0 ? Instructions.removed : ready),
          render: {
            initial: renderDrivers,
            changed: (_previous, current) =>
              [
                "The ready subagent drivers have changed. This list supersedes the previous one.",
                renderDrivers(current),
              ].join("\n"),
            removed: () => "No vendor drivers are ready anymore. Use only the ocpp driver for subagents.",
          },
        })
        // Earlier sessions stored the list of subagent agents under this key. That value no longer decodes, so
        // such a session is shown this guidance afresh rather than as a change.
        const usage = Instructions.make<true>({
          key: Instructions.Key.make("core/subagent-guidance"),
          codec: Schema.toCodecJson(Schema.Literal(true)),
          read: Effect.succeed(callable ? true : Instructions.removed),
          render: {
            initial: render,
            changed: render,
            removed: () => "Subagents are not available anymore. Do not call `tools.subagent`.",
          },
        })
        return Instructions.combine([usage, guidance])
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ExternalAgentDrivers.node],
})
