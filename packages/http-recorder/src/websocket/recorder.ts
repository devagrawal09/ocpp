import { NodeFileSystem } from "@effect/platform-node-shared"
import { Deferred, Effect, Exit, Layer, Ref, Scope, Semaphore } from "effect"
import { Socket } from "effect/socket"
import { fileSystem, type Interface, Service } from "../cassette/store.js"
import type { SocketRecorderOptions } from "../options.js"
import { make, type Redactor } from "../redaction/redactor.js"
import { canonicalizeJson, decodeJson, safeText } from "../replay/comparison.js"
import { makeReplayState, resolveAutoMode } from "../replay/state.js"
import { webSocketInteractions, type Interaction } from "../cassette/model.js"
import type { WebSocketEvent, WebSocketInteraction } from "./model.js"

interface WebSocketRecorderOptions extends SocketRecorderOptions {
  readonly compareClientMessagesAsJson?: boolean
}
interface ActiveReplay {
  readonly interaction: WebSocketInteraction
  readonly progress: Ref.Ref<{ readonly position: number; readonly changed: Deferred.Deferred<void> }>
  readonly writeLock: Semaphore.Semaphore
  // The close frame written by the client, if any.
  readonly closed: Ref.Ref<Socket.CloseEvent | undefined>
  // Set when the reader scope closes, so a suspended pull fails as the Socket contract requires.
  readonly released: Ref.Ref<boolean>
}
interface ActiveRecording {
  readonly events: Array<WebSocketEvent>
  readonly eventLock: Semaphore.Semaphore
  readonly accepting: Ref.Ref<boolean>
  opened: boolean
  valid: boolean
}
interface PendingRecordings {
  readonly promises: Set<Promise<void>>
  readonly errors: Array<unknown>
}
type Frame = string | Uint8Array

const normalizeProtocols = (protocols: unknown): Array<string> => {
  if (typeof protocols === "string") return [protocols]
  if (Array.isArray(protocols)) return protocols.filter((protocol): protocol is string => typeof protocol === "string")
  return []
}
const frameFromWebSocketData = async (data: unknown): Promise<Frame> => {
  if (typeof data === "string") return data
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
  throw new Error(`Unsupported WebSocket frame: ${Object.prototype.toString.call(data)}`)
}
const closeEvent = (code: number, reason: string): CloseEvent => {
  if (typeof globalThis.CloseEvent === "function")
    return new globalThis.CloseEvent("close", { code, reason, wasClean: code === 1000 })
  const event = new Event("close")
  Object.defineProperties(event, {
    code: { value: code },
    reason: { value: reason },
    wasClean: { value: code === 1000 },
  })
  return event as CloseEvent
}
const errorEvent = (error: unknown): ErrorEvent => {
  if (typeof globalThis.ErrorEvent === "function")
    return new globalThis.ErrorEvent("error", {
      error,
      message: error instanceof Error ? error.message : String(error),
    })
  const event = new Event("error")
  Object.defineProperties(event, {
    error: { value: error },
    message: { value: error instanceof Error ? error.message : String(error) },
  })
  return event as ErrorEvent
}
const webSocketFacade = (
  target: EventTarget,
  properties: {
    readonly url: () => string
    readonly readyState: () => number
    readonly protocol: () => string
    readonly extensions: () => string
    readonly bufferedAmount: () => number
    readonly send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => void
    readonly close: (code?: number, reason?: string) => void
  },
): globalThis.WebSocket => {
  Object.defineProperties(target, {
    url: { get: properties.url },
    readyState: { get: properties.readyState },
    protocol: { get: properties.protocol },
    extensions: { get: properties.extensions },
    bufferedAmount: { get: properties.bufferedAmount },
    binaryType: { value: "blob", writable: true },
    send: { value: properties.send },
    close: { value: properties.close },
    CONNECTING: { value: 0 },
    OPEN: { value: 1 },
    CLOSING: { value: 2 },
    CLOSED: { value: 3 },
  })
  for (const name of ["open", "message", "error", "close"] as const) {
    let handler: ((event: Event) => unknown) | null = null
    Object.defineProperty(target, `on${name}`, {
      get: () => handler,
      set: (next) => {
        if (handler) target.removeEventListener(name, handler)
        handler = typeof next === "function" ? next : null
        if (handler) target.addEventListener(name, handler)
      },
    })
  }
  return target as globalThis.WebSocket
}

const encodeEvent = (direction: "client" | "server", message: Frame): WebSocketEvent =>
  typeof message === "string"
    ? { direction, kind: "text", body: message }
    : { direction, kind: "binary", body: Buffer.from(message).toString("base64"), bodyEncoding: "base64" }
const decodeEvent = (event: WebSocketEvent): Frame =>
  event.kind === "text" ? event.body : new Uint8Array(Buffer.from(event.body, "base64"))
const redactEvent = (event: WebSocketEvent, redactor: Redactor): WebSocketEvent => {
  if (event.kind === "binary") return event
  const body =
    event.direction === "client"
      ? redactor.request({ method: "WEBSOCKET", url: "", headers: {}, body: event.body }).body
      : redactor.response({ status: 101, headers: {}, body: event.body }).body
  return { ...event, body }
}
const comparable = (event: WebSocketEvent, asJson: boolean) => {
  if (!asJson || event.kind === "binary") return JSON.stringify(canonicalizeJson(event))
  const decoded = decodeJson(event.body)
  return JSON.stringify(
    canonicalizeJson({ ...event, body: decoded._tag === "None" ? event.body : canonicalizeJson(decoded.value) }),
  )
}
const assertEvent = (actual: WebSocketEvent, expected: WebSocketEvent | undefined, index: number, asJson: boolean) =>
  Effect.sync(() => {
    if (expected && comparable(actual, asJson) === comparable(expected, asJson)) return
    throw new Error(`WebSocket event ${index + 1}: expected ${safeText(expected)}, received ${safeText(actual)}`)
  })
const closeError = (code: number, closeReason?: string) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code, closeReason }) })
const unconsumedEvents = (state: ActiveReplay, position: number) =>
  new Error(`WebSocket closed with unconsumed events: used ${position} of ${state.interaction.events.length}`)

// A recorded run spans one reader acquisition: it starts when the upstream connection opens and is
// appended to the cassette when the reader scope closes successfully.
const makeRecordingSocket = (
  upstream: Socket.Socket,
  cassette: Interface,
  name: string,
  options: WebSocketRecorderOptions,
  redactor: Redactor,
) =>
  Effect.gen(function* () {
    const active = yield* Ref.make<ActiveRecording | undefined>(undefined)
    const writeLock = yield* Semaphore.make(1)
    return Socket.make({
      reader: Effect.gen(function* () {
        const state: ActiveRecording = {
          events: [],
          eventLock: yield* Semaphore.make(1),
          accepting: yield* Ref.make(true),
          opened: false,
          valid: true,
        }
        const occupied = yield* Ref.modify(active, (current) => [current !== undefined, current ?? state])
        if (occupied) return yield* Effect.die("Concurrent runs of a recorded WebSocket are not supported")
        yield* Effect.addFinalizer((exit) =>
          writeLock.withPermit(
            state.eventLock.withPermit(
              Effect.gen(function* () {
                yield* Ref.set(state.accepting, false)
                yield* Ref.set(active, undefined)
                if (!Exit.isSuccess(exit) || !state.opened || !state.valid) return
                yield* cassette
                  .append(name, { transport: "websocket", events: [...state.events] }, options.metadata)
                  .pipe(Effect.orDie)
              }),
            ),
          ),
        )
        const reader = yield* upstream.reader
        state.opened = true
        return {
          pull: reader.pull.pipe(
            Effect.tap((frames) =>
              Effect.sync(() => {
                if (!Ref.getUnsafe(state.accepting)) throw new Error("WebSocket received a frame after closing")
                state.events.push(...frames.map((frame) => redactEvent(encodeEvent("server", frame), redactor)))
              }),
            ),
          ),
          upgrade: reader.upgrade,
        }
      }),
      writer: upstream.writer.pipe(
        Effect.map((writer) => {
          const record = (frames: ReadonlyArray<Frame>, send: Effect.Effect<void, Socket.SocketError>) =>
            writeLock.withPermit(
              Effect.gen(function* () {
                const state = yield* Ref.get(active)
                if (!state || !(yield* Ref.get(state.accepting)))
                  return yield* Effect.die("WebSocket writer used without an active socket run")
                const events = frames.map((frame) => redactEvent(encodeEvent("client", frame), redactor))
                yield* state.eventLock.withPermit(Effect.sync(() => state.events.push(...events)))
                return yield* send.pipe(Effect.onError(() => Effect.sync(() => (state.valid = false))))
              }),
            )
          return {
            write: (chunk) =>
              Socket.isCloseEvent(chunk)
                ? writeLock.withPermit(writer.write(chunk))
                : record([chunk], writer.write(chunk)),
            writeAll: (chunks) => record(chunks, writer.writeAll(chunks)),
          }
        }),
      ),
    })
  })

// A replayed run spans one reader acquisition and claims the next recorded interaction. Server frames
// are released in recorded order once every preceding client frame has been written.
const makeReplaySocket = (
  cassette: Interface,
  name: string,
  options: WebSocketRecorderOptions,
  redactor: Redactor,
): Effect.Effect<Socket.Socket, never, Scope.Scope> =>
  Effect.gen(function* () {
    const replay = yield* makeReplayState(cassette, name, webSocketInteractions)
    const active = yield* Ref.make<ActiveReplay | undefined>(undefined)
    const busy = yield* Ref.make(false)
    const write = (chunk: Frame | Socket.CloseEvent) =>
      Ref.get(active).pipe(
        Effect.flatMap((state) =>
          state
            ? state.writeLock.withPermit(
                Effect.gen(function* () {
                  const current = yield* Ref.get(state.progress)
                  if (Socket.isCloseEvent(chunk)) {
                    yield* Ref.set(state.closed, chunk)
                    yield* Deferred.succeed(current.changed, undefined)
                    if (current.position === state.interaction.events.length) return
                    return yield* Effect.die(unconsumedEvents(state, current.position))
                  }
                  const actual = redactEvent(encodeEvent("client", chunk), redactor)
                  yield* assertEvent(
                    actual,
                    state.interaction.events[current.position],
                    current.position,
                    options.compareClientMessagesAsJson === true,
                  )
                  yield* Ref.set(state.progress, {
                    position: current.position + 1,
                    changed: yield* Deferred.make<void>(),
                  })
                  yield* Deferred.succeed(current.changed, undefined)
                }),
              )
            : Effect.die("WebSocket writer used without an active socket run"),
        ),
      )
    return Socket.make({
      reader: Effect.gen(function* () {
        if (yield* Ref.modify(busy, (current) => [current, true]))
          return yield* Effect.die("Concurrent runs of a replayed WebSocket are not supported")
        yield* Effect.addFinalizer(() => Ref.set(busy, false))
        const claimed = yield* replay
          .claim((interaction) => (interaction ? Effect.void : Effect.die("Missing recorded WebSocket interaction")))
          .pipe(Effect.orDie)
        const state: ActiveReplay = {
          interaction: claimed.interaction,
          progress: yield* Ref.make({ position: 0, changed: yield* Deferred.make<void>() }),
          writeLock: yield* Semaphore.make(1),
          closed: yield* Ref.make<Socket.CloseEvent | undefined>(undefined),
          released: yield* Ref.make(false),
        }
        yield* Ref.set(active, state)
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Ref.set(active, undefined)
            yield* Ref.set(state.released, true)
            yield* Deferred.succeed((yield* Ref.get(state.progress)).changed, undefined)
          }),
        )
        return { pull: pullReplay(state), upgrade: Socket.SocketUpgradeError.unsupported }
      }),
      writer: Effect.succeed({
        write,
        writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }),
      }),
    })
  })

const pullReplay = (state: ActiveReplay) =>
  Effect.gen(function* () {
    while (true) {
      const current = yield* Ref.get(state.progress)
      if (yield* Ref.get(state.released)) return yield* closeError(1006)
      const event = state.interaction.events[current.position]
      const closed = yield* Ref.get(state.closed)
      if (!event) return yield* closed ? closeError(closed.code, closed.reason) : closeError(1000)
      if (closed) return yield* Effect.die(unconsumedEvents(state, current.position))
      if (event.direction === "server") {
        // Consecutive server frames are delivered together, mirroring same-tick frame batching.
        const following = state.interaction.events.slice(current.position + 1)
        const end = following.findIndex((next) => next.direction !== "server")
        const rest = end === -1 ? following : following.slice(0, end)
        yield* Ref.set(state.progress, {
          position: current.position + 1 + rest.length,
          changed: yield* Deferred.make<void>(),
        })
        const frames: [Frame, ...Array<Frame>] = [decodeEvent(event), ...rest.map(decodeEvent)]
        return frames
      }
      yield* Deferred.await(current.changed)
    }
  })

const recordingLayer = (
  name: string,
  options: WebSocketRecorderOptions,
  forcedMode?: "record" | "replay",
): Layer.Layer<Socket.Socket, never, Socket.Socket | Service> =>
  Layer.effect(
    Socket.Socket,
    Effect.gen(function* () {
      const upstream = yield* Socket.Socket
      const cassette = yield* Service
      const redactor = make(options.redact)
      if ((forcedMode ?? (yield* resolveAutoMode(cassette, name))) === "record")
        return yield* makeRecordingSocket(upstream, cassette, name, options, redactor)
      return yield* makeReplaySocket(cassette, name, options, redactor)
    }),
  )

export const layerSocket = (
  name: string,
  options: SocketRecorderOptions = {},
): Layer.Layer<Socket.Socket, never, Socket.Socket> =>
  provideCassette(recordingLayer(name, { ...options, compareClientMessagesAsJson: true }), options)
/** @internal */
export const layerSocketWithMode = (
  name: string,
  options: WebSocketRecorderOptions & { readonly mode: "record" | "replay" },
): Layer.Layer<Socket.Socket, never, Socket.Socket> =>
  provideCassette(recordingLayer(name, options, options.mode), options)
const provideCassette = <A, E, R>(layer: Layer.Layer<A, E, R>, options: WebSocketRecorderOptions) =>
  layer.pipe(Layer.provide(fileSystem({ directory: options.directory })), Layer.provide(NodeFileSystem.layer))

const makeRecordingWebSocketConstructor = (
  upstream: Socket.WebSocketConstructor["Service"],
  cassette: Interface,
  name: string,
  metadata: SocketRecorderOptions["metadata"],
  redactor: Redactor,
  pending: PendingRecordings,
): Socket.WebSocketConstructor["Service"] => {
  let nextSequence = 0
  return (url, protocols) => {
    const sequence = nextSequence++
    const requestedProtocols = normalizeProtocols(protocols)
    const native = Reflect.apply(upstream, undefined, [url, protocols])
    const events: WebSocketEvent[] = []
    let opened = false
    let failed = false
    let closed = false
    let queue = Promise.resolve()
    const appendEvent = (direction: "client" | "server", data: unknown) => {
      queue = queue.then(async () => {
        if (failed || closed) return
        try {
          events.push(redactEvent(encodeEvent(direction, await frameFromWebSocketData(data)), redactor))
        } catch {
          failed = true
        }
      })
    }
    const onOpen = () => {
      opened = true
    }
    const onMessage = (event: Socket.WebSocketEvent) => {
      appendEvent("server", event.data)
    }
    const onError = () => {
      failed = true
    }
    const onClose = (event: Socket.WebSocketEvent) => {
      native.removeEventListener("open", onOpen)
      native.removeEventListener("message", onMessage)
      native.removeEventListener("error", onError)
      native.removeEventListener("close", onClose)
      const completion = queue.then(async () => {
        closed = true
        if (opened && !failed) {
          const request = redactor.request({ method: "WEBSOCKET", url, headers: {}, body: "" })
          const interaction: WebSocketInteraction = {
            transport: "websocket",
            connection: {
              sequence,
              url: request.url,
              protocols: requestedProtocols,
              close: { code: event.code ?? 1006, reason: event.reason ?? "" },
            },
            events: [...events],
          }
          events.length = 0
          await Effect.runPromise(cassette.append(name, interaction, metadata).pipe(Effect.orDie))
        }
      })
      pending.promises.add(completion)
      void completion.then(
        () => pending.promises.delete(completion),
        (error) => {
          pending.promises.delete(completion)
          pending.errors.push(error)
        },
      )
    }
    native.addEventListener("open", onOpen)
    native.addEventListener("message", onMessage)
    native.addEventListener("error", onError)
    native.addEventListener("close", onClose)
    return new Proxy(native, {
      get: (target, property) => {
        if (property === "send")
          return (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            Reflect.apply(target.send, target, [data])
            appendEvent("client", data)
          }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
      set: (target, property, value) => Reflect.set(target, property, value, target),
    })
  }
}

const constructorWebSocketInteractions = (interactions: ReadonlyArray<Interaction>) =>
  webSocketInteractions(interactions)
    .filter((interaction) => interaction.connection !== undefined)
    .map((interaction, index) => ({ interaction, index }))
    .toSorted((a, b) => a.interaction.connection!.sequence - b.interaction.connection!.sequence)
    .map(({ interaction }) => interaction)

const makeReplayWebSocketConstructor = (
  cassette: Interface,
  name: string,
  redactor: Redactor,
): Effect.Effect<Socket.WebSocketConstructor["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const replay = yield* makeReplayState(cassette, name, constructorWebSocketInteractions)
    return (url, protocols) => {
      const target = new EventTarget()
      const requestedProtocols = normalizeProtocols(protocols)
      const request = redactor.request({ method: "WEBSOCKET", url, headers: {}, body: "" })
      let readyState = 0
      let interaction: WebSocketInteraction | undefined
      let position = 0
      let finished = false
      let closeRequested = false
      let operations = Promise.resolve()
      const fail = (error: unknown) => {
        if (finished) return
        finished = true
        readyState = 3
        target.dispatchEvent(errorEvent(error))
      }
      const finish = () => {
        if (finished || !interaction || position !== interaction.events.length) return
        finished = true
        readyState = 3
        const terminal = interaction.connection?.close ?? { code: 1000, reason: "" }
        target.dispatchEvent(closeEvent(terminal.code, terminal.reason))
      }
      const drive = () => {
        if (!interaction || finished) return
        while (interaction.events[position]?.direction === "server") {
          const event = interaction.events[position++]
          if (!event) break
          target.dispatchEvent(new MessageEvent("message", { data: decodeEvent(event) }))
        }
        if (position === interaction.events.length) setTimeout(finish, 0)
      }
      Effect.runPromise(
        replay
          .claim((recorded, index) =>
            Effect.sync(() => {
              if (!recorded) throw new Error(`Missing recorded WebSocket connection ${index + 1}`)
              const connection = recorded.connection
              if (!connection) throw new Error(`WebSocket interaction ${index + 1} has no connection metadata`)
              if (connection.url !== request.url)
                throw new Error(
                  `WebSocket connection ${index + 1}: expected URL ${safeText(connection.url)}, received ${safeText(request.url)}`,
                )
              if (
                connection.protocols.length !== requestedProtocols.length ||
                connection.protocols.some((protocol, protocolIndex) => protocol !== requestedProtocols[protocolIndex])
              )
                throw new Error(
                  `WebSocket connection ${index + 1}: expected protocols ${safeText(connection.protocols)}, received ${safeText(requestedProtocols)}`,
                )
            }),
          )
          .pipe(Effect.orDie),
      ).then((claimed) => {
        if (closeRequested) return fail(new Error("WebSocket closed before it opened"))
        interaction = claimed.interaction
        readyState = 1
        target.dispatchEvent(new Event("open"))
        drive()
      }, fail)
      return webSocketFacade(target, {
        url: () => url,
        readyState: () => readyState,
        protocol: () => requestedProtocols[0] ?? "",
        extensions: () => "",
        bufferedAmount: () => 0,
        send: (data) => {
          if (!interaction || readyState !== 1 || closeRequested) throw new Error("WebSocket is not open")
          operations = operations.then(async () => {
            try {
              const frame = await frameFromWebSocketData(data)
              const actual = redactEvent(encodeEvent("client", frame), redactor)
              Effect.runSync(assertEvent(actual, interaction?.events[position], position, true))
              position += 1
              drive()
            } catch (error) {
              fail(error)
            }
          })
        },
        close: () => {
          if (closeRequested || readyState === 3) return
          closeRequested = true
          readyState = 2
          operations = operations.then(() => {
            if (!interaction) return
            if (position !== interaction.events.length)
              return fail(
                new Error(`WebSocket closed with unconsumed events: used ${position} of ${interaction.events.length}`),
              )
            finish()
          })
        },
      })
    }
  })

export const layerWebSocketConstructor = (
  name: string,
  options: SocketRecorderOptions = {},
): Layer.Layer<Socket.WebSocketConstructor, never, Socket.WebSocketConstructor> =>
  provideCassette(
    Layer.effect(
      Socket.WebSocketConstructor,
      Effect.gen(function* () {
        const upstream = yield* Socket.WebSocketConstructor
        const cassette = yield* Service
        const redactor = make(options.redact)
        if ((yield* resolveAutoMode(cassette, name)) === "replay")
          return yield* makeReplayWebSocketConstructor(cassette, name, redactor)
        const pending: PendingRecordings = { promises: new Set(), errors: [] }
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => Promise.all(pending.promises)).pipe(
            Effect.flatMap(() => (pending.errors.length === 0 ? Effect.void : Effect.die(pending.errors[0]))),
          ),
        )
        return makeRecordingWebSocketConstructor(upstream, cassette, name, options.metadata, redactor, pending)
      }),
    ),
    options,
  )
