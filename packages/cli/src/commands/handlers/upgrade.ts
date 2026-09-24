import { intro, log, outro, spinner } from "@clack/prompts"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Updater } from "../../services/updater"
import { handlePromptErrors } from "../../ui/prompt"
import { OCPP_VERSION } from "../../version"

export default Runtime.handler(
  Commands.commands.upgrade,
  Effect.fn("cli.upgrade")(function* (input) {
    intro("Upgrade")
    const updater = yield* Updater.Service
    const method = Option.getOrUndefined(input.method) ?? (yield* updater.method())
    if (!method)
      return yield* Effect.fail(
        new Error("Could not detect the installation method. Pass --method to choose how to upgrade OC++."),
      )

    log.info(`Using method: ${method}`)
    const target = Option.getOrUndefined(input.target) ?? (yield* updater.latest())
    const version = target.trim().replace(/^v/, "")
    if (version === OCPP_VERSION) {
      log.warn(`OC++ upgrade skipped: ${version} is already installed`)
      outro("Done")
      return
    }

    log.info(`From ${OCPP_VERSION} → ${version}`)
    const progress = spinner()
    progress.start("Upgrading...")
    yield* updater.upgrade(method, target).pipe(
      Effect.tap(() => Effect.sync(() => progress.stop("Upgrade complete"))),
      Effect.tapCause(() => Effect.sync(() => progress.stop("Upgrade failed", 1))),
    )
    outro("Done")
  }, handlePromptErrors),
)
