import { Effect } from "effect"
import { define } from "@ocpp/plugin/effect/plugin"
import { Provider } from "../../provider.js"

export const NvidiaPlugin = define({
  id: "ocpp.provider.nvidia",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((evt) => {
      for (const item of evt.provider.list()) {
        if (!Provider.isAISDK(item.provider.package)) continue
        if (Provider.packageName(item.provider.package) !== "@ai-sdk/openai-compatible") continue
        if (item.provider.settings?.baseURL !== "https://integrate.api.nvidia.com/v1") continue
        evt.provider.update(item.provider.id, (provider) => {
          provider.headers = {
            ...provider.headers,
            "HTTP-Referer": "https://ocpp.ai/",
            "X-Title": "ocpp",
            "X-BILLING-INVOKE-ORIGIN": provider.headers?.["X-BILLING-INVOKE-ORIGIN"] ?? "OC++",
          }
        })
      }
    })
  }),
})
