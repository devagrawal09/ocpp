export * as ConfigFormatterPlugin from "./formatter.js"

import { define } from "@ocpp/plugin/effect/plugin"
import { FSUtil } from "@ocpp/util/fs-util"
import { Global } from "@ocpp/util/global"
import { Npm } from "@ocpp/util/npm"
import { AppProcess } from "@ocpp/util/process"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { Formatter } from "../../formatter.js"
import { make, type Info } from "../../formatter/builtins.js"
import { Location } from "../../location.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export const Plugin = define({
  id: "ocpp.config.formatter",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const formatter = yield* Formatter.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const npm = yield* Npm.Service
    const processes = yield* AppProcess.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, formatter.reload())

    yield* formatter.transform((draft) => {
      const configured = Config.latest(loaded.entries, "formatter")
      if (!configured) return
      const builtIns = make({
        directory: location.directory,
        worktree: location.project.directory,
        fs,
        npm,
        processes,
        bin: global.bin,
      })
      builtIns.forEach(draft.set)
      if (configured === true) return

      for (const [name, entry] of Object.entries(configured)) {
        if (entry.disabled) {
          draft.remove(name)
          continue
        }
        const builtIn = builtIns.find((formatter) => formatter.name === name)
        const current: Info = {
          name,
          extensions: entry.extensions ?? builtIn?.extensions ?? [],
          environment: { ...builtIn?.environment, ...entry.environment },
          enabled:
            builtIn && !entry.command ? builtIn.enabled : Effect.succeed(entry.command ? [...entry.command] : false),
        }
        draft.set(current)
      }
    })
  }),
})
