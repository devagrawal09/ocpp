import { join } from "node:path"

import { EventLog } from "@specter-ts/core"
import { createJsonlEventLog, createJsonlReactionOutboxStore, createJsonlSliceStoreLayer } from "@specter-ts/jsonl"
import type { OutboxedReaction } from "@specter-ts/reaction-outbox"
import { Effect, Exit, Layer, Scope } from "effect"

import type { RunStepOutboxOptions } from "../../src/app.ts"
import { makeEmbeddedSessionRuntime } from "../../src/embedded.ts"
import type { RunStepRequest } from "../../src/features/session/run-step-reaction/impl.ts"
import type { ScriptedStepHost } from "./scripted-step-host.ts"

// The embedded runtime as a host composes it, kept in files: a JSONL Event
// Log, JSON Slice stores and a JSONL outbox for steps, all in one directory.
// Opening the same directory again is the restart: the Event Log and outbox
// take over a dead process's locks, the outbox releases the attempt that
// process left running, and the step Plugin resumes it.
export const openJsonlRuntime = async (options: {
  readonly directory: string
  readonly host: ScriptedStepHost
  // Lease, heartbeat, backoff and shutdown wait of the step outbox.
  readonly outbox?: RunStepOutboxOptions
}) => {
  const log = createJsonlEventLog({ path: join(options.directory, "events.jsonl") })
  const outbox = createJsonlReactionOutboxStore<OutboxedReaction<RunStepRequest>>({
    path: join(options.directory, "outbox.jsonl"),
  })
  const scope = Effect.runSync(Scope.make())
  try {
    const runtime = await Effect.runPromise(
      makeEmbeddedSessionRuntime({
        ...(options.outbox ? { outbox: options.outbox } : {}),
        stores: {
          runStep: outbox,
          slices: (tag, createState) =>
            createJsonlSliceStoreLayer(tag, createState, { directory: join(options.directory, "slices") }),
        },
      }).pipe(Effect.provide(Layer.mergeAll(Layer.succeed(EventLog, log), options.host.layer)), Scope.provide(scope)),
    )
    return {
      runtime,
      log,
      outbox,
      // Orderly shutdown: the worker stops claiming and stops a running
      // attempt, then both files are closed.
      close: async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void))
        outbox.close()
        log.close()
      },
    }
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    outbox.close()
    log.close()
    throw cause
  }
}
