export * as SubagentInstructions from "./instructions.js"

import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Agent } from "../agent.js"
import { ExternalAgentDrivers } from "../external-agent/drivers.js"
import { Instructions } from "../instructions/index.js"
import { SubagentTool } from "../tool/plugin/subagent.js"

const Summary = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
})
type Summary = typeof Summary.Type

// The Code Mode catalog shows only the first line of `tools.subagent`'s description, so the agent IDs
// it accepts are listed here.
const render = (subagents: ReadonlyArray<Summary>) =>
  [
    "Subagents work on a task in a child session. Start one with `tools.subagent`, passing one of these IDs as `agent` and the child's tools as `tools`.",
    "An agent is a prompt and model preset; it grants no tools. The child can call exactly the tools you pass: your own tools such as tools.read, whole namespaces such as tools.linear, and tool.define handles. Without `tools` it has none, only tools.submit_result when you pass an outputSchema.",
    ...(subagents.some((subagent) => subagent.id === "explore")
      ? [
          "Typical lists: explore gets [tools.read, tools.glob, tools.grep, tools.webfetch]; general gets the tools its task needs.",
        ]
      : []),
    "Pass `root` to run one in another existing directory, such as a separate git worktree.",
    "Available subagents:",
    ...SubagentTool.listing(subagents),
  ].join("\n")

const update = (previous: ReadonlyArray<Summary>, current: ReadonlyArray<Summary>) => {
  const diff = Instructions.diffByKey(
    previous,
    current,
    (subagent) => subagent.id,
    (before, after) => before.description !== after.description,
  )
  // Additions and removals render as small deltas; anything else restates the full list.
  if (diff.changed.length > 0 || (diff.added.length === 0 && diff.removed.length === 0))
    return [
      "The available subagents have changed. This list supersedes the previous available subagents list.",
      render(current),
    ].join("\n")
  return [
    ...(diff.added.length === 0
      ? []
      : ["New subagents are available in addition to those previously listed:", ...SubagentTool.listing(diff.added)]),
    ...(diff.removed.length === 0
      ? []
      : [
          `The following subagent IDs are no longer available and must not be used: ${diff.removed.map((subagent) => subagent.id).join(", ")}.`,
        ]),
  ].join("\n")
}

const Driver = Schema.Struct({ id: Schema.String, name: Schema.String, model: Schema.String })
type Driver = typeof Driver.Type

const renderDrivers = (drivers: ReadonlyArray<Driver>) =>
  [
    "`tools.subagent` takes a `driver`: `ocpp` runs the child with the OC++ runner and a provider model; a vendor driver runs it with that vendor's agent and the user's own login, in the OC++ harness unless you pass `harness: \"native\"`. A new child takes its agent's configured model's driver, else this session's own.",
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
    const agents = yield* Agent.Service
    const drivers = yield* ExternalAgentDrivers.Service

    return Service.of({
      load: Effect.fn("SubagentInstructions.load")(function* (catalog) {
        const callable = catalog.includes(SubagentTool.name)
        const subagents = callable ? SubagentTool.available(yield* agents.list()) : []
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
        const listing = Instructions.make<ReadonlyArray<Summary>>({
          key: Instructions.Key.make("core/subagent-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          read: Effect.succeed(subagents.length === 0 ? Instructions.removed : subagents),
          render: {
            initial: render,
            changed: update,
            removed: () => "No subagents are available anymore. Do not call `tools.subagent`.",
          },
        })
        return Instructions.combine([listing, guidance])
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Agent.node, ExternalAgentDrivers.node],
})
