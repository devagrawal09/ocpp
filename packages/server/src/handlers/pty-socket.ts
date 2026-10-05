import { Effect } from "effect"
import { Socket } from "effect/socket"

export function runPtySocket<A, E, R, A2, E2, R2>(
  drain: Effect.Effect<A, E, R>,
  socket: Effect.Effect<A2, E2, R2>,
  detach: () => void,
) {
  return Effect.raceFirst(drain, socket).pipe(Effect.ensuring(Effect.sync(detach)))
}

// Acquiring the reader opens the socket, so `onOpen` runs once before the first frame is handled. Every close,
// clean ones included, ends the read with a `SocketCloseError`.
export function readPtySocket<E, R>(
  socket: Socket.Socket,
  handle: (message: string | Uint8Array) => Effect.Effect<void, E, R>,
  onOpen: Effect.Effect<void, E, R> = Effect.void,
) {
  return Effect.gen(function* () {
    const reader = yield* socket.reader
    yield* onOpen
    while (true) {
      for (const message of yield* reader.pull) yield* handle(message)
    }
  }).pipe(Effect.scoped)
}
