import { Data, Effect, Stream } from "effect"

export type ModelPart =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; callId: string; tool: string; input: Record<string, string> }

export class ModelError extends Data.TaggedError("ModelError")<{ readonly message: string }> {}

export type TurnModel = {
  readonly stream: (request: { executionId: string; prompt: string }) => Stream.Stream<ModelPart, ModelError>
}

/**
 * Streaming model for tests and the harness. Output is deterministic only so assertions can
 * compare it; a re-streamed turn may differ, because the first commit for a delivery key wins.
 */
export function fakeModel(
  options: { tokens?: number; delayMs?: number; toolCall?: boolean; failAfter?: number } = {},
): TurnModel {
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
