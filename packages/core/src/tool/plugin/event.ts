export * as EventTool from "./event.js"

import type { Context } from "@ocpp/plugin/effect/plugin"
import { CodeModeExecution } from "@ocpp/schema/codemode-execution"
import { Tool } from "@ocpp/schema/tool"
import { Effect, Schema } from "effect"
import { CodeModeEvent } from "../../codemode/event.js"
import { CodeModeInvocation } from "../../codemode/invocation-service.js"

const namespace = "event"

const Name = Schema.String.annotate({ description: "Event name" })
const Named = Schema.Struct({ name: Name })

export const Plugin = {
  id: "ocpp.tool.event",
  effect: Effect.fn("EventTool.Plugin")(function* (ctx: Context) {
    const events = yield* CodeModeEvent.Service
    const invocations = yield* CodeModeInvocation.Service

    const found = (name: string) => (info: CodeModeEvent.Info | undefined) =>
      info === undefined
        ? Effect.fail(new Tool.Error({ message: `No event is named ${name}.` }))
        : Effect.succeed({ output: info, content: describe(info) })

    yield* ctx.tool
      .transform((draft) => {
        draft.add({
          name: "define",
          options: { namespace },
          description: [
            'Define or replace an event that runs a saved notebook function on a schedule: `{ every: "5m" }`, `{ cron: "0 9 * * 1-5" }`, or `{ at: "<ISO time>" }`.',
            "Each firing runs `return handler({ event, firedAt, input })` as its own execution with this Session's tools. A firing is skipped while the previous one still runs. You are not woken: firings show in the timeline, and their outcomes reach you as notifications on your next turn. Call `tools.session.notify` from the handler to wake yourself.",
            "`handler` is the name of a top-level function in the notebook, which may be declared in the same program. Events keep firing across restarts; missed firings are not replayed.",
          ].join("\n"),
          input: Schema.Struct({
            name: Name,
            description: Schema.String.pipe(Schema.optionalKey),
            schedule: CodeModeEvent.Schedule,
            handler: Schema.String.annotate({ description: "Name of the notebook function to call" }),
            input: Schema.Json.pipe(Schema.optionalKey).annotate({ description: "Passed to every firing as `input`" }),
          }),
          output: CodeModeEvent.Info,
          execute: (input, context) =>
            events.define(context.sessionID, { ...input, description: input.description ?? "" }).pipe(
              Effect.map((info) => ({ output: info, content: describe(info) })),
              Effect.mapError((error) => new Tool.Error({ message: error.message })),
            ),
        })
        draft.add({
          name: "list",
          options: { namespace },
          description:
            "List events with their schedule, whether enabled, next and last firing, last status and result, and run and skip counts.",
          input: Schema.Struct({}),
          output: Schema.Array(CodeModeEvent.Info),
          execute: (_, context) =>
            events.list(context.sessionID).pipe(
              Effect.map((list) => ({
                output: list,
                content: list.length === 0 ? "No events are defined." : list.map(describe).join("\n"),
              })),
            ),
        })
        draft.add({
          name: "enable",
          options: { namespace },
          description: "Resume firing an event on its schedule.",
          input: Named,
          output: CodeModeEvent.Info,
          execute: (input, context) =>
            events
              .setEnabled({ sessionID: context.sessionID, name: input.name }, true)
              .pipe(Effect.flatMap(found(input.name))),
        })
        draft.add({
          name: "disable",
          options: { namespace },
          description: "Stop firing an event until it is enabled again. A running firing continues.",
          input: Named,
          output: CodeModeEvent.Info,
          execute: (input, context) =>
            events
              .setEnabled({ sessionID: context.sessionID, name: input.name }, false)
              .pipe(Effect.flatMap(found(input.name))),
        })
        draft.add({
          name: "remove",
          options: { namespace },
          description: "Remove an event. Its handler stays in the notebook.",
          input: Named,
          output: Schema.Struct({ removed: Schema.Boolean }),
          execute: (input, context) =>
            events.remove({ sessionID: context.sessionID, name: input.name }).pipe(
              Effect.map((removed) => ({
                output: { removed },
                content: removed ? `Removed event ${input.name}.` : `No event is named ${input.name}.`,
              })),
            ),
        })
        draft.add({
          name: "trigger",
          options: { namespace },
          description:
            "Fire an event now, whether or not it is enabled. `input` replaces the event's input for this firing. Returns once the firing starts or is skipped.",
          input: Schema.Struct({ name: Name, input: Schema.Json.pipe(Schema.optionalKey) }),
          output: Schema.Union([
            Schema.Struct({ status: Schema.Literal("started"), executionID: CodeModeExecution.ID }),
            Schema.Struct({ status: Schema.Literal("skipped") }),
          ]),
          execute: (input, context) =>
            invocations.fire({ sessionID: context.sessionID, ...input }).pipe(
              Effect.map((firing) =>
                firing.status === "skipped"
                  ? {
                      output: { status: "skipped" as const },
                      content: `Skipped ${input.name}: its previous firing is still running.`,
                    }
                  : {
                      output: { status: "started" as const, executionID: firing.executionID },
                      content: `Fired ${input.name} as execution ${firing.executionID}.`,
                    },
              ),
              Effect.mapError((error) => new Tool.Error({ message: error.message })),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
}

function describe(info: CodeModeEvent.Info) {
  return [
    `${info.name} (${info.enabled ? "enabled" : "disabled"}, ${JSON.stringify(info.schedule)}) -> ${info.handler}`,
    ...(info.nextFireAt ? [`next ${info.nextFireAt}`] : []),
    ...(info.lastFiredAt ? [`last ${info.lastFiredAt}${info.lastStatus ? " " + info.lastStatus : ""}`] : []),
    ...(info.lastSummary ? [info.lastSummary] : []),
  ].join("; ")
}
