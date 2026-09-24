import { Bus } from "@ocpp/core/bus"
import { Image } from "@ocpp/core/image"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import type { LocationServices } from "@ocpp/core/location-services"
import { PluginHooks } from "@ocpp/core/plugin/hooks"
import { PluginSupervisor } from "@ocpp/core/plugin/supervisor-service"
import { Reference } from "@ocpp/core/reference"
import { SessionPrompt } from "@ocpp/core/session/prompt"
import { Skill } from "@ocpp/core/skill"
import type { Location } from "@ocpp/schema/location"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { FSUtil } from "@ocpp/util/fs-util"
import { Effect, Layer, LayerMap } from "effect"

// Plain-prompt unit fixtures use virtual directories without configured references.
export const promptLocationNode = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const fs = yield* FSUtil.Service
      return yield* LayerMap.make(
        (_ref: Location.Ref) =>
          SessionPrompt.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                LayerNode.compile(LayerNode.group([PluginHooks.node, Image.node, Skill.node]), [
                  [Bus.node, Layer.succeed(Bus.Service, bus)],
                ]),
                Layer.succeed(FSUtil.Service, fs),
                Layer.succeed(PluginSupervisor.Service, { flush: Effect.void }),
                Layer.mock(Reference.Service, { refresh: () => Effect.void }),
              ),
            ),
          ) as Layer.Layer<LocationServices>,
      )
    }),
  ),
  deps: [Bus.node, FSUtil.node],
})
