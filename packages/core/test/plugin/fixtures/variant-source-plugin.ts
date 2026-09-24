import { Plugin } from "@ocpp/plugin/effect"
import { Model } from "@ocpp/core/model"
import { Provider } from "@ocpp/core/provider"
import { Effect } from "effect"

export default Plugin.define({
  id: "variant-source",
  effect: (ctx) =>
    ctx.catalog
      .transform((catalog) => {
        catalog.provider.update("configured", (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/openai-compatible")
        })
        catalog.model.update("configured", "glm-5.2", (model) => {
          model.modelID = Model.ID.make("glm-5.2")
          model.package = Provider.aisdk("@ai-sdk/openai-compatible")
          model.variants = [
            {
              id: Model.VariantID.make("high"),
              settings: {},
              headers: { custom: "true" },
              body: {},
            },
          ]
        })
      })
      .pipe(Effect.asVoid),
})
