export * as SubagentInstructions from "./instructions.js"

import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Agent } from "../agent.js"
import { Instructions } from "../instructions/index.js"
import { Tool } from "../tool.js"
import { SubagentTool } from "../tool/plugin/subagent.js"
import { effectiveName } from "../tool/runtime.js"

const Summary = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
})
type Summary = typeof Summary.Type

// The Code Mode catalog shows only the first line of `tools.subagent`'s description, so the agent IDs
// it accepts are listed here.
const render = (subagents: ReadonlyArray<Summary>) =>
  [
    "Subagents work on a task in a child session. Start one with `tools.subagent`, passing one of these IDs as `agent`.",
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

export interface Interface {
  readonly load: (agent: Agent.Selection) => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/SubagentInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const tools = yield* Tool.Service

    return Service.of({
      load: Effect.fn("SubagentInstructions.load")(function* (selection) {
        const agent = selection.info
        if (!agent) return Instructions.empty
        const callable = (yield* tools.registrations(agent.permissions)).some(
          (tool) => effectiveName(tool) === SubagentTool.name,
        )
        const subagents = callable ? SubagentTool.available(yield* agents.list(), agent.permissions) : []
        return Instructions.make<ReadonlyArray<Summary>>({
          key: Instructions.Key.make("core/subagent-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          read: Effect.succeed(subagents.length === 0 ? Instructions.removed : subagents),
          render: {
            initial: render,
            changed: update,
            removed: () => "No subagents are available anymore. Do not call `tools.subagent`.",
          },
        })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Agent.node, Tool.node] })
