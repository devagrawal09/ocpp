/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill.js"

import { define, type Context } from "@ocpp/plugin/effect/plugin"
import { Effect } from "effect"
import { AbsolutePath } from "../schema.js"
import { Skill } from "../skill.js"
import { ConfigPluginSource } from "../config/plugin/source.js"
import os from "os"
import ocppContent from "./skill/ocpp.md" with { type: "text" }
import reportContent from "./skill/report.md" with { type: "text" }

export const OcppContent = ocppContent
export const ReportContent = reportContent

export const OcppDescription =
  "Use this skill for any question about OC++ itself, including how OC++ works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OC++ SDK, clients, server, or API, and contributing to the OC++ codebase. Also use it for OC++ agents, commands, skills, tools and tool lists, MCP servers, providers, models, themes, keybinds, formatters, the CLI, and the web app."
const REPORT_DESCRIPTION =
  "Use when the user wants to report an ocpp issue or bug. Collect standard diagnostics, add user-specific reproduction context, and publish the issue with GitHub CLI."

export const Plugin = define({
  id: "ocpp.skill",
  effect: Effect.fn(function* (ctx) {
    const reportContent = yield* reportContentWithDiagnostics(ctx.app)
    yield* ctx.skill.transform((draft) => {
      draft.add(
        Skill.Info.make({
          id: Skill.ID.make("ocpp"),
          name: Skill.Name.make("OC++"),
          description: OcppDescription,
          location: AbsolutePath.make("/builtin/ocpp.md"),
          content: OcppContent,
        }),
      )
      draft.add(
        Skill.Info.make({
          id: Skill.ID.make("report"),
          name: Skill.Name.make("Report"),
          description: REPORT_DESCRIPTION,
          slash: true,
          location: AbsolutePath.make("/builtin/report.md"),
          content: reportContent,
        }),
      )
    })
  }),
})

const reportContentWithDiagnostics = Effect.fn("SkillPlugin.reportContentWithDiagnostics")(function* (
  app: Context["app"],
) {
  const plugins = yield* configuredPlugins()
  return [
    ReportContent,
    "",
    "## Runtime Diagnostics Snapshot",
    "",
    "These values were captured when the built-in report skill was registered. Verify them before publishing.",
    "",
    `- ocpp version: ${app.version}`,
    `- install/channel: ${app.channel}`,
    `- OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
    `- Terminal: ${terminal()}`,
    `- Shell: ${shell()}`,
    `- Active plugins: ${plugins.length === 0 ? "None found in config" : plugins.join(", ")}`,
  ].join("\n")
})

const configuredPlugins = Effect.fn("SkillPlugin.configuredPlugins")(function* () {
  const sources = yield* ConfigPluginSource.Service
  return (yield* sources.operations())
    .map((operation) => (operation.type === "remove" ? `-${operation.target}` : operation.target))
    .toSorted()
})

function terminal() {
  return (
    [
      process.env.TERM_PROGRAM ? `TERM_PROGRAM=${process.env.TERM_PROGRAM}` : undefined,
      process.env.TERM ? `TERM=${process.env.TERM}` : undefined,
      process.env.COLORTERM ? `COLORTERM=${process.env.COLORTERM}` : undefined,
    ]
      .filter((item): item is string => item !== undefined)
      .join(", ") || "Unavailable: terminal environment variables are not set"
  )
}

function shell() {
  return (
    process.env.SHELL ??
    process.env.ComSpec ??
    process.env.COMSPEC ??
    "Unavailable: shell environment variable is not set"
  )
}
