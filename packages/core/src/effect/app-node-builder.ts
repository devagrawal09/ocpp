import { buildLocationServiceMap } from "../location-services.js"
import { LocationServiceMap } from "../location-service-map.js"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { SpecterSessions } from "../specter/index.js"

export function build<A, E>(root: LayerNode.Node<A, E, any>, input: LayerNode.Replacements = []) {
  const bound = SpecterSessions.bindings.find(([node]) => hasReplacement(input, node))
  if (bound) throw new Error(`${bound[0].name} runs on the Specter runtime; replace SpecterStepHost.node instead`)
  const replacements = [...input, ...SpecterSessions.bindings]
  // Only build the location service map if it's actually needed
  if (
    !LayerNode.hasUnbound(root, LocationServiceMap.node, replacements) ||
    hasReplacement(replacements, LocationServiceMap.node)
  )
    return LayerNode.compile(root, replacements)

  const locationMap = buildLocationServiceMap(replacements)
  const locationMapNode = makeGlobalNode({ service: LocationServiceMap.Service, layer: locationMap, deps: [] })
  return LayerNode.compile(root, replacements.concat([[LocationServiceMap.node, locationMapNode]]))
}

function hasReplacement(replacements: LayerNode.Replacements, node: LayerNode.Node<unknown, unknown, any>) {
  return replacements.some(([source]) => source.name === node.name)
}

export * as AppNodeBuilder from "./app-node-builder.js"
