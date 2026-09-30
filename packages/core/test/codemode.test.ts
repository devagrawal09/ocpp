import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Location } from "@ocpp/core/location"
import { AbsolutePath } from "@ocpp/core/schema"
import { Tool } from "@ocpp/core/tool"
import { Effect, Schema } from "effect"
import { it } from "./lib/effect"

describe("CodeMode", () => {
  it.effect("owns registrations, execute, and catalog materialization", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((draft) =>
        draft.add({
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.String,
          options: { pinned: true },
          execute: ({ text }) => Effect.succeed({ output: text }),
        }),
      )

      const snapshot = yield* tools.snapshot()
      expect(snapshot.definitions.some((tool) => tool.name === "execute")).toBe(true)
      expect(snapshot.codeModeCatalog?.filter((entry) => !entry.path.startsWith("notebook."))).toStrictEqual([
        {
          path: "echo",
          description: "Echo text",
          signature: "tools.echo(input: {\n  text: string,\n}): string",
          pinned: true,
        },
      ])
      expect(
        snapshot.codeModeCatalog
          ?.filter((entry) => entry.path.startsWith("notebook."))
          .map((entry) => ({ path: entry.path, pinned: entry.pinned })),
      ).toEqual([
        { path: "notebook.inspect", pinned: true },
        { path: "notebook.list", pinned: true },
      ])
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AppNodeBuilder.build(Tool.node, [
          [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
        ]),
      ),
    ),
  )
})
