export * as ExternalAgentGateway from "./gateway.js"

import { Effect, Schema } from "effect"

/** One OC++ tool offered to a vendor over MCP (or as a Pi custom tool). */
export interface Definition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, Schema.Json>
}

export interface Entry extends Definition {
  /** `id` is the vendor's own ID for the call, when its protocol names one. Failures are model-facing text. */
  readonly invoke: (input: Record<string, unknown>, id?: string) => Effect.Effect<string, string>
}

/** The only boundary that invokes OC++ tools for a vendor. SDK adapters never receive the tools themselves. */
export interface Gateway {
  readonly definitions: ReadonlyArray<Definition>
  readonly invoke: (name: string, input: unknown, id?: string) => Effect.Effect<string, string>
}

const decode = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))

export function make(entries: ReadonlyArray<Entry>): Gateway {
  return {
    definitions: entries.map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
    })),
    invoke: (name, input, id) =>
      Effect.gen(function* () {
        const entry = entries.find((item) => item.name === name)
        if (entry === undefined) return yield* Effect.fail("Unknown OC++ tool: " + name)
        const decoded = yield* decode(input).pipe(Effect.mapError(() => "Tool input must be an object"))
        return yield* entry.invoke(decoded, id)
      }),
  }
}
