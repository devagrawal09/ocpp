export * as NotifyTool from "./notify.js"

import type { Context } from "@ocpp/plugin/effect/plugin"
import { Tool } from "@ocpp/schema/tool"
import { Effect, Schema } from "effect"
import { PluginRuntime } from "../../plugin/runtime.js"

export const Plugin = {
  id: "ocpp.tool.session.notify",
  effect: Effect.fn("NotifyTool.Plugin")(function* (ctx: Context) {
    const runtime = yield* PluginRuntime.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add({
          name: "notify",
          options: { namespace: "session" },
          description:
            "Send the model a message that wakes it, or steers it if it is already working. Command and event handlers use it when something needs the model's attention.",
          input: Schema.Struct({ text: Schema.String.check(Schema.isNonEmpty()) }),
          execute: (input, context) =>
            runtime.session
              .synthetic({
                sessionID: context.sessionID,
                text: input.text,
                description: input.text.split("\n", 1)[0]!.slice(0, 120),
                metadata: { source: "notify" },
              })
              .pipe(
                Effect.mapError((error) => new Tool.Error({ message: error.message })),
                Effect.as({ content: "Notified." }),
              ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
