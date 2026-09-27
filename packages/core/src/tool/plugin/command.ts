export * as CommandTool from "./command.js"

import type { Context } from "@ocpp/plugin/effect/plugin"
import { Tool } from "@ocpp/schema/tool"
import { Effect, Schema } from "effect"
import { Bus } from "../../bus.js"
import { CodeModeCommand } from "../../codemode/command.js"
import { Command } from "../../command.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"

const namespace = "command"

const Name = Schema.String.annotate({ description: 'Command name, typed as "/name" in the prompt input' })

export const Plugin = {
  id: "ocpp.tool.command",
  effect: Effect.fn("CommandTool.Plugin")(function* (ctx: Context) {
    const bus = yield* Bus.Service
    const commands = yield* CodeModeCommand.Service
    const location = yield* Location.Service
    const locationCommands = yield* Command.Service
    const permission = yield* Permission.Service
    // The prompt input lists commands per Location, so it refreshes on the Location's command event.
    const updated = bus
      .publish(
        Command.Event.Updated,
        {},
        { location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }) },
      )
      .pipe(Effect.asVoid)

    yield* ctx.tool
      .transform((draft) => {
        draft.add({
          name: "define",
          options: { namespace },
          description: [
            "Define or replace a slash command that runs a saved notebook function instead of prompting you.",
            "When the user submits `/name some text`, the Session runs `return handler({ text, command })` as its own execution, where `text` is everything after the command name. The command takes text only, not files or mentions. You are not woken: the run shows in the timeline, and its outcome reaches you as a notification on your next turn. If it runs again before you see that, you get one notification that counts the runs and shows the latest outcome.",
            "`handler` is the name of a top-level function in the notebook, which may be declared in the same program. A name the app or this project already uses for a command (such as /compact, /undo, /fork, or a configured command) is refused.",
            "Commands persist with the Session and are copied when it is forked. Reverting the message that saved the handler removes the command.",
          ].join("\n"),
          input: Schema.Struct({
            name: Name,
            description: Schema.String.pipe(Schema.optionalKey).annotate({
              description: "Shown next to the command in the prompt input",
            }),
            handler: Schema.String.annotate({ description: "Name of the notebook function to call" }),
          }),
          output: CodeModeCommand.Info,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: "command_define",
                resources: [input.name],
                save: ["*"],
                metadata: { handler: input.handler },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              // The user's commands keep their names; Session commands never shadow them.
              if ((yield* locationCommands.list()).some((command) => command.name === input.name))
                return yield* new Tool.Error({
                  message: `/${input.name} is already a command in this project (configured, from a plugin, or built in). Choose another name.`,
                })
              const command = yield* commands.define(context.sessionID, {
                ...input,
                description: input.description ?? "",
              })
              yield* updated
              return {
                output: command,
                content: `Command /${command.name} runs ${command.handler}({ text, command }).`,
              }
            }).pipe(Effect.mapError((error) => new Tool.Error({ message: error.message }))),
        })
        draft.add({
          name: "list",
          options: { namespace },
          description: "List this Session's slash commands and the notebook functions they call.",
          input: Schema.Struct({}),
          output: Schema.Array(CodeModeCommand.Info),
          execute: (_, context) =>
            commands.list(context.sessionID).pipe(
              Effect.map((list) => ({
                output: list,
                content:
                  list.length === 0
                    ? "No commands are defined."
                    : list.map((command) => `/${command.name} -> ${command.handler}`).join("\n"),
              })),
            ),
        })
        draft.add({
          name: "remove",
          options: { namespace },
          description: "Remove a slash command. Its handler stays in the notebook.",
          input: Schema.Struct({ name: Name }),
          output: Schema.Struct({ removed: Schema.Boolean }),
          execute: (input, context) =>
            commands.remove(context.sessionID, input.name).pipe(
              Effect.tap((removed) => (removed ? updated : Effect.void)),
              Effect.map((removed) => ({
                output: { removed },
                content: removed ? `Removed /${input.name}.` : `No command is named /${input.name}.`,
              })),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
}
