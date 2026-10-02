export * as DisplayResultTool from "./display-result.js"

import type { Context } from "@ocpp/plugin/effect/plugin"
import { SessionMessage } from "@ocpp/schema/session-message"
import { Tool } from "@ocpp/schema/tool"
import { Effect, Schema } from "effect"
import { PluginRuntime } from "../../plugin/runtime.js"

const limits = SessionMessage.DisplayLimits

const description = [
  "Show the user a result in the Session timeline, outside the execution trace. Use it for output meant for the user, such as a command's answer, rather than returning it.",
  "Blocks render in order: { type: 'markdown', text }, { type: 'code', text, language? }, and { type: 'table', columns: [{ key, label }], rows: [{ [key]: cell }] }. A cell is a string, number, boolean, null, or { type: 'file', path }, which the user can open.",
  "The model never sees displayed results, and displaying does not wake it. Each call appends a new result and returns its { id }.",
  "A result holds at most " +
    limits.blocks +
    " blocks, " +
    limits.columns +
    " columns, " +
    limits.rows +
    " rows per table, and " +
    limits.bytes / 1024 +
    " KiB in total. Larger results are rejected, not truncated.",
].join("\n")

export const Plugin = {
  id: "ocpp.tool.display_result",
  effect: Effect.fn("DisplayResultTool.Plugin")(function* (ctx: Context) {
    const runtime = yield* PluginRuntime.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add({
          name: "display_result",
          options: { reattach: true },
          description,
          input: SessionMessage.DisplayInput,
          output: Schema.Struct({ id: SessionMessage.ID }),
          execute: (input, context) =>
            Effect.gen(function* () {
              // The ID is recorded before publishing, so a call interrupted by a restart reuses it and the
              // Session returns the result it already displayed instead of showing it twice.
              const recovered = context.recovered?.id
              const id =
                typeof recovered === "string" && recovered.startsWith("msg_")
                  ? SessionMessage.ID.make(recovered)
                  : SessionMessage.ID.create()
              yield* context.progress({ id })
              const displayed = yield* runtime.session.display({
                sessionID: context.sessionID,
                id,
                title: input.title,
                blocks: input.blocks,
              })
              return { output: displayed, content: "Displayed result " + displayed.id + "." }
            }).pipe(Effect.mapError((error) => new Tool.Error({ message: error.message }))),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
