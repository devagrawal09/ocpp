import { Context, Effect, Layer, LayerMap } from "effect"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Node } from "@ocpp/util/effect/app-node"
import { Location } from "./location.js"
import type { Instance } from "./instance.js"

export class Service extends Context.Service<
  Service,
  LayerMap.LayerMap<Location.Ref, Instance.Services, Instance.Error>
>()("@ocpp/example/LocationServiceMap") {
  static get(ref: Location.Ref) {
    return Layer.unwrap(Effect.map(Service, (locations) => locations.get(ref)))
  }
}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

export * as LocationServiceMap from "./location-service-map.js"
