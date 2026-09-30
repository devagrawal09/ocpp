import { Effect, Fiber, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { Updater } from "../../services/updater"

export default Runtime.handler(Commands, (input) =>
  Effect.gen(function* () {
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
      mismatch: "replace",
      onStart: (reason) =>
        process.stderr.write(
          reason === "version-mismatch"
            ? "Restarting background server (version mismatch)...\n"
            : "Starting background server...\n",
        ),
    })
    const updater = yield* Updater.Service
    const update = yield* updater.check().pipe(Effect.forkScoped)
    process.stdout.write(`OC++ is running at ${server.endpoint.url}\n`)
    const { default: open } = yield* Effect.promise(() => import("open"))
    // `open` resolves once the launcher spawns, so it can't report whether a browser appeared.
    yield* Effect.promise(() => open(server.endpoint.url)).pipe(Effect.catchCause(() => Effect.void))
    // A standalone server lives in this process, so keep it running until the user stops it.
    if (input.standalone) {
      process.stdout.write("Press Ctrl+C to stop the server.\n")
      return yield* Effect.never
    }
    yield* Fiber.join(update)
  }),
)
