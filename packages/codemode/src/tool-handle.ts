import { Effect, type JsonSchema } from "effect"

export type ToolHandleDefinition = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema.JsonSchema
  readonly outputSchema: JsonSchema.JsonSchema
  readonly capabilities: ReadonlyArray<string>
}

export class ToolHandle {
  private active = true

  constructor(
    readonly definition: ToolHandleDefinition,
    private readonly run: (input: unknown) => Effect.Effect<unknown, unknown>,
  ) {}

  invoke(input: unknown) {
    if (!this.active) return Effect.fail(new Error("Tool handle is no longer active"))
    return this.run(input)
  }

  close() {
    this.active = false
  }
}

export const isToolHandle = (value: unknown): value is ToolHandle => value instanceof ToolHandle
