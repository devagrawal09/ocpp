import { LocationServiceMap } from "@ocpp/core/location-service-map"
import type { LocationServices } from "@ocpp/core/location-services"
import type { Location } from "@ocpp/schema/location"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Context, Deferred, Effect, Layer, LayerMap } from "effect"

/**
 * Every Location shares the test app's own Location services (bound to one directory): the Specter
 * runtime reaches each step's I/O through a LocationServiceMap, which hands it the app's context once
 * `bind` runs inside the app. Each build gets its own binding.
 */
export const makeSharedLocation = () => {
  const binding = { current: Deferred.makeUnsafe<Context.Context<never>>() }
  const node = makeGlobalNode({
    service: LocationServiceMap.Service,
    layer: Layer.effect(
      LocationServiceMap.Service,
      Effect.suspend(() => {
        const context = Deferred.makeUnsafe<Context.Context<never>>()
        binding.current = context
        return LayerMap.make(
          (_ref: Location.Ref) => Layer.effectContext(Deferred.await(context)) as Layer.Layer<LocationServices>,
        )
      }),
    ),
    deps: [],
  })
  const bind = Effect.context<never>().pipe(
    Effect.flatMap((context) => Deferred.succeed(binding.current, context)),
    Effect.asVoid,
  )
  return { node, bind }
}
