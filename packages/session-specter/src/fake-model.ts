import { Data, Effect, Stream } from "effect"

export type ModelPart =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; callId: string; tool: string; input: Record<string, string> }

export class ModelError extends Data.TaggedError("ModelError")<{ readonly message: string }> {}

export type Model = {
  readonly stream: (request: { executionId: string; prompt: string }) => Stream.Stream<ModelPart, ModelError>
}

/**
 * Deterministic streaming model: the same request always yields the same tokens, so a
 * retried turn re-records identical payloads and deliveryId-keyed Commands deduplicate.
 */
export function fakeModel(
  options: { tokens?: number; delayMs?: number; toolCall?: boolean; failAfter?: number } = {},
): Model {
  const tokens = options.tokens ?? 20
  const delayMs = options.delayMs ?? 0
  return {
    stream: (request) =>
      Stream.fromIterable(Array.from({ length: tokens }, (_, index) => index)).pipe(
        Stream.mapEffect((index) =>
          index === options.failAfter
            ? Effect.fail(new ModelError({ message: `Fake model failed after ${index} tokens` }))
            : Effect.sleep(delayMs).pipe(
                Effect.as<ModelPart>({ type: "text-delta", text: `${request.prompt.length + index} ` }),
              ),
        ),
        Stream.concat(
          options.toolCall
            ? Stream.make<ModelPart[]>({
                type: "tool-call",
                callId: `call_${request.executionId}`,
                tool: "read",
                input: { path: "README.md" },
              })
            : Stream.empty,
        ),
      ),
  }
}
