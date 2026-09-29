/**
 * Model-facing file-write leaf. Relative paths resolve within the active
 * Location; absolute paths may name any file.
 */
export * as WriteTool from "./write.js"

import type { Context } from "@ocpp/plugin/effect/plugin"
import { ToolFailure } from "@ocpp/ai"
import { Effect, Schema } from "effect"
import { Environment } from "../../environment/index.js"
import { FileMutation } from "../../file-mutation.js"
import { Formatter } from "../../formatter.js"
import { LocationMutation } from "../../location-mutation.js"

export const name = "write"

// TODO: Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.
export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description: "Path to the file to write to",
  }),
  content: Schema.String.annotate({ description: "Content to write to the file" }),
})

export const Output = Schema.Struct({
  operation: Schema.Literal("write"),
  target: Schema.String,
  resource: Schema.String,
  existed: Schema.Boolean,
})
export type Output = typeof Output.Type

export const toModelContent = (output: Output) =>
  `${output.existed ? "Wrote" : "Created"} file successfully: ${output.resource}`

/** Deferred write UX integrations remain visible at the model-facing seam. */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after LSP runtime exists.

export const Plugin = {
  id: "ocpp.tool.write",
  effect: Effect.fn("WriteTool.Plugin")(function* (ctx: Context) {
    const mutation = yield* LocationMutation.Service
    const fileMutation = yield* FileMutation.Service
    const environment = yield* Environment.Service
    const formatter = yield* Formatter.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add({
          name,
          description:
            "Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use `tools.edit` instead.",
          input: Input,
          output: Output,
          execute: (input) =>
            Effect.gen(function* () {
              const target = yield* mutation.resolve({ path: input.path })
              const result = yield* fileMutation.writeTextPreservingBom({ target, content: input.content })
              const bom = (yield* FileMutation.readText(environment.files, target.absolute)).bom
              if (yield* formatter.file(target.absolute)) {
                yield* FileMutation.syncTextBom(environment.files, target.absolute, bom)
              }
              return result
            }).pipe(
              Effect.map((output) => ({ output, content: toModelContent(output) })),
              Effect.mapError((error) => new ToolFailure({ message: `Unable to write ${input.path}`, error })),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
