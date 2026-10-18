import { Context, Effect, Layer, Scope, Stream } from "effect"
import { ModelError, type ModelPart, type TurnModel } from "./fake-model"

/**
 * Streams turns through OC++'s own model stack: `ModelResolver.fromCatalogModel` maps an AI SDK
 * package to a native `@ocpp/ai` route when one exists and otherwise loads it through the
 * `AISDK` service, and `LLM.stream` runs it over `LLMClient`. Both run on the same Effect
 * runtime as Specter, so the outbox worker consumes the Stream directly.
 *
 * Selected with `SESSION_SPECTER_MODEL=real`. `SESSION_SPECTER_PROVIDER` (default `anthropic`),
 * `SESSION_SPECTER_PACKAGE` (default `@ai-sdk/anthropic`) and `SESSION_SPECTER_MODEL_ID`
 * (default `claude-haiku-4-5`) pick the model; credentials come from the provider's usual
 * environment variable, such as `ANTHROPIC_API_KEY`. No AISDK SDK hooks are registered, so an
 * AI SDK package without a native route fails to resolve.
 */
export async function realModel(): Promise<TurnModel> {
  const { AISDK } = await import("@ocpp/core/aisdk")
  const { Model } = await import("@ocpp/core/model")
  const { ModelResolver } = await import("@ocpp/core/model-resolver")
  const { Provider } = await import("@ocpp/core/provider")
  const { LLM } = await import("@ocpp/ai")
  const { LLMClient, RequestExecutor } = await import("@ocpp/ai/route")

  const info = Model.Info.make({
    ...Model.Info.default(
      Provider.ID.make(process.env.SESSION_SPECTER_PROVIDER ?? "anthropic"),
      Model.ID.make(process.env.SESSION_SPECTER_MODEL_ID ?? "claude-haiku-4-5"),
    ),
    package: Provider.aisdk(process.env.SESSION_SPECTER_PACKAGE ?? "@ai-sdk/anthropic"),
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      // Lives for the process, like the model clients OC++ keeps per Location.
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(
        Layer.mergeAll(AISDK.locationLayer, LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
        scope,
      )
      const model = yield* ModelResolver.fromCatalogModel(info, undefined, {
        loadAISDK: Context.get(context, AISDK.Service).model,
      })
      return {
        stream: (request) =>
          LLM.stream(LLM.request({ model, prompt: request.prompt, generation: { maxTokens: 512 } })).pipe(
            Stream.flatMap((event) =>
              event.type === "text-delta"
                ? Stream.make<ModelPart[]>({ type: "text-delta", text: event.text })
                : Stream.empty,
            ),
            Stream.mapError((error) => new ModelError({ message: error.message })),
            Stream.provideContext(context),
          ),
      } satisfies TurnModel
    }),
  )
}
