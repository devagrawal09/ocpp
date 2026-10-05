import { join } from "node:path"
import { makeSpecterRuntime } from "@specter-ts/core/effect"
import { createJsonlEventLogLayer, createJsonlSliceStoreLayer } from "@specter-ts/jsonl"
import { createMemorySliceStoreLayer } from "@specter-ts/memory"
import type { OutboxedReaction, ReactionOutboxTransitionListener } from "@specter-ts/reaction-outbox"
import { Effect, Exit, Layer, Option, Scope, Stream } from "effect"
import {
  completeExecution,
  createSession,
  createSessionDecision,
  DecisionStore,
  enqueuePrompt,
  failExecution,
  recordText,
  recordToolCall,
  recordToolResult,
  startExecution,
} from "./commands"
import { sessionEvents } from "./events"
import { fakeModel, type Model } from "./fake-model"
import { openFileReactionOutboxStore } from "./outbox-store"
import { MessagesStore, sessionMessages, sessionStatus, StatusStore } from "./queries"
import { createRunTurnState, runTurn, RunTurnStore, SessionTurns, type RunTurn, type TurnMetrics } from "./run-turn"

export const sessionAppConfig = {
  events: sessionEvents,
  slices: {
    createSession,
    enqueuePrompt,
    startExecution,
    recordText,
    recordToolCall,
    recordToolResult,
    completeExecution,
    failExecution,
    sessionMessages,
    sessionStatus,
    runTurn,
  },
} as const

export type SessionAppOptions = {
  readonly root: string
  readonly sessionId: string
  readonly model?: Model
  /** `jsonl` persists the Reaction cursor; `memory` replays every commit through the Reaction on open. */
  readonly reactionStore?: "jsonl" | "memory"
  readonly pollIntervalMs?: number
  readonly metrics?: TurnMetrics
  readonly onTransition?: ReactionOutboxTransitionListener<OutboxedReaction<RunTurn>>
}

export type SessionApp = Awaited<ReturnType<typeof open>>

const opened = new Map<string, Promise<SessionApp>>()

/** Opens, or reuses, the one Specter app that owns `<root>/sessions/<sessionId>`. */
export function openSessionApp(options: SessionAppOptions) {
  const sessionDir = join(options.root, "sessions", options.sessionId)
  const existing = opened.get(sessionDir)
  if (existing) return existing
  const session = open(sessionDir, options)
  opened.set(sessionDir, session)
  session.catch(() => opened.delete(sessionDir))
  return session
}

export function closeAllSessionApps() {
  return Promise.all([...opened.values()].map((session) => session.then((value) => value.close())))
}

async function open(sessionDir: string, options: SessionAppOptions) {
  const outbox = await openFileReactionOutboxStore<OutboxedReaction<RunTurn>>(join(sessionDir, "outbox.jsonl"))
  const dependencies = Layer.mergeAll(
    createJsonlEventLogLayer({ path: join(sessionDir, "events.jsonl") }),
    createMemorySliceStoreLayer(DecisionStore, createSessionDecision),
    createMemorySliceStoreLayer(MessagesStore, () => ({ pending: {}, messages: [] })),
    createMemorySliceStoreLayer(StatusStore, () => ({ created: false, running: null, queued: [], succeeded: 0, failed: 0 })),
    options.reactionStore === "memory"
      ? createMemorySliceStoreLayer(RunTurnStore, createRunTurnState)
      : createJsonlSliceStoreLayer(RunTurnStore, createRunTurnState, { directory: join(sessionDir, "slices") }),
    Layer.succeed(SessionTurns, {
      sessionDir,
      model: options.model ?? fakeModel(),
      outbox,
      pollIntervalMs: options.pollIntervalMs ?? 20,
      onTransition: options.onTransition,
      metrics: options.metrics,
    }),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(dependencies, scope)
      // The runtime catches the Reaction up and forks the outbox worker in this scope.
      const app = yield* makeSpecterRuntime(sessionAppConfig).pipe(Effect.provide(context), Scope.provide(scope))
      return {
        sessionId: options.sessionId,
        sessionDir,
        app,
        outbox,
        /** Resolves once the Session is idle with nothing queued. */
        awaitIdle: () =>
          Effect.runPromise(
            app.subscribe({ type: "sessionStatus", payload: {} }).pipe(
              Stream.filter((status) => status.status === "idle" && status.queued === 0),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            ),
          ),
        close: async () => {
          opened.delete(sessionDir)
          await Effect.runPromise(Scope.close(scope, Exit.void))
        },
      }
    }),
  )
}
