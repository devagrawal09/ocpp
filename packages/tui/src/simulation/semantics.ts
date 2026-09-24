import type { Renderable } from "@opentui/core"
import type { SimulationProtocol } from "@ocpp/simulation/protocol"

type Definition = Omit<SimulationProtocol.Frontend.SemanticNode, "id" | "element" | "parent">

const key = Symbol.for("ocpp.simulation.semantics")

const bind = (definition: () => Definition) => (renderable: Renderable) => {
  Object.defineProperty(renderable, key, { value: definition, configurable: true })
}

export const SimulationSemantics = { bind }
