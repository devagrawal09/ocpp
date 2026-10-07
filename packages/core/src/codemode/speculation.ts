export * as CodeModeSpeculation from "./speculation.js"

import type { CodeMode } from "@ocpp/codemode"
import { Effect, Fiber, type Scope } from "effect"
import { journalValue } from "./replay.js"

/** Bounds on one execution's speculative calls. Zero in either disables speculation. */
export type Caps = {
  /** Speculative calls started and not yet consumed or dropped, at once. */
  readonly maxSpeculativeCalls: number
  /** Speculative calls started over the whole execution. */
  readonly maxSpeculativeCallsPerExecution: number
}

/** How a proposed call is treated, decided from the host's tool policy. */
export type Admission =
  /** A read-only call that may start before the program reaches it. */
  | "speculate"
  /** A call that changes nothing and never reaches the host gateway, such as tools.search. */
  | "skip"
  /** Anything else. Neither it nor any later call in the window starts early, so a read never passes a write. */
  | "barrier"

/** Progress a speculative call reports before the program reaches it, kept until the call is consumed. */
const MAX_BUFFERED_PROGRESS = 32

export const validate = (caps: Caps) => {
  for (const [name, value] of Object.entries(caps))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError("Speculation limit " + name + " must be a non-negative safe integer, got " + value + ".")
  return caps
}

/**
 * Holds results of read-only tool calls started before the program reaches them, for one execution.
 * Each result is keyed by the index the call will take among the execution's calls and by its tool
 * and decoded input, in the form the journal compares, so two identical calls are two entries and a
 * result is only ever served to the exact call it was started for. Admission is decided before
 * anything starts; a call that does not fit is dropped, never queued.
 */
export const make = <A, E, M>(input: {
  readonly caps: Caps
  /** Calls before this index may be served from the journal or rejoin earlier work, so none starts early. */
  readonly firstLive: number
  readonly admission: (name: string) => Admission
  /** True while something outside the program, such as a plugin hook, observes or can refuse tool calls. */
  readonly intercepted: Effect.Effect<boolean>
  /** Starts one call through the same path the gateway runs live calls through. */
  readonly start: (
    call: CodeMode.ToolCallProposal,
    progress: (metadata: M) => Effect.Effect<void>,
  ) => Effect.Effect<A, E>
  /** The execution's scope, which owns every speculative fiber. */
  readonly scope: Scope.Scope
}) => {
  const caps = validate(input.caps)
  const enabled = caps.maxSpeculativeCalls > 0 && caps.maxSpeculativeCallsPerExecution > 0
  type Entry = { readonly key: string; readonly fiber: Fiber.Fiber<A, E>; readonly attach: Attach<M> }
  const entries = new Map<number, Entry>()
  let started = 0
  let closed = false

  // An abandoned call is interrupted in the background, so the program never waits on it.
  const abandon = (entry: Entry) => Fiber.interrupt(entry.fiber).pipe(Effect.forkIn(input.scope), Effect.asVoid)

  const dropBefore = (index: number) =>
    Effect.suspend(() => {
      const stale = Array.from(entries).filter(([position]) => position < index)
      for (const [position] of stale) entries.delete(position)
      return Effect.forEach(stale, ([, entry]) => abandon(entry), { discard: true })
    })

  const admit = (calls: ReadonlyArray<CodeMode.ToolCallProposal>) =>
    Effect.gen(function* () {
      for (const call of calls) {
        if (closed || call.index < input.firstLive) return
        const admission = input.admission(call.name)
        if (admission === "skip") continue
        if (admission === "barrier") return
        const key = keyOf(call.name, call.input)
        if (key === undefined) return
        const held = entries.get(call.index)
        if (held?.key === key) continue
        // The program's bindings changed since this call was proposed, so its input did too.
        if (held !== undefined) {
          entries.delete(call.index)
          yield* abandon(held)
        }
        if (entries.size >= caps.maxSpeculativeCalls || started >= caps.maxSpeculativeCallsPerExecution) return
        started++
        const router = route<M>()
        const fiber = yield* input.start(call, router.progress).pipe(Effect.forkIn(input.scope))
        entries.set(call.index, { key, fiber, attach: router.attach })
      }
    })

  return {
    /** False when either cap is zero: the program then proposes nothing and no call starts early. */
    enabled,
    /** Offers the calls the program makes next, in order. Starts what it admits and drops the rest. */
    offer: (calls: ReadonlyArray<CodeMode.ToolCallProposal>): Effect.Effect<void> =>
      !enabled
        ? Effect.void
        : Effect.flatMap(input.intercepted, (intercepted) =>
            intercepted || closed || calls.length === 0 ? Effect.void : admit(calls),
          ),
    /**
     * The held result for the call the program makes now, or undefined when none matches. A match is
     * consumed: its progress so far is replayed into `progress`, and later progress goes there too.
     * Results held for earlier positions can no longer match and are interrupted.
     */
    take: (index: number, name: string, value: unknown, progress: (metadata: M) => Effect.Effect<void>) =>
      Effect.gen(function* () {
        yield* dropBefore(index)
        const entry = entries.get(index)
        if (entry === undefined) return undefined
        entries.delete(index)
        if (entry.key !== keyOf(name, value)) {
          yield* abandon(entry)
          return undefined
        }
        yield* entry.attach(progress)
        return Fiber.join(entry.fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(entry.fiber)))
      }),
    /** Discards anything held for this call and earlier ones, for a call that does not run live. */
    drop: (index: number) => dropBefore(index + 1),
    /** Interrupts every unconsumed call. Nothing starts after this. */
    close: Effect.suspend(() => {
      closed = true
      const remaining = Array.from(entries.values())
      entries.clear()
      return Effect.forEach(remaining, (entry) => Fiber.interrupt(entry.fiber), { discard: true })
    }),
    /** Speculative calls started so far. */
    started: () => started,
  }
}

/** The key the gateway compares: tool path and the journal's JSON form of the decoded input. */
function keyOf(name: string, value: unknown) {
  try {
    return name + "\n" + JSON.stringify(journalValue(value))
  } catch {
    return undefined
  }
}

type Attach<M> = (target: (metadata: M) => Effect.Effect<void>) => Effect.Effect<void>

/** Buffers progress until the call is consumed, then forwards it to the consuming call. */
function route<M>() {
  let sink: ((metadata: M) => Effect.Effect<void>) | undefined
  let buffered: Array<M> = []
  return {
    progress: (metadata: M) =>
      Effect.suspend(() =>
        sink !== undefined
          ? sink(metadata)
          : Effect.sync(() => {
              buffered = [...buffered.slice(1 - MAX_BUFFERED_PROGRESS), metadata]
            }),
      ),
    attach: ((target) =>
      Effect.gen(function* () {
        while (buffered.length > 0) {
          const pending = buffered
          buffered = []
          yield* Effect.forEach(pending, target, { discard: true })
        }
        sink = target
      })) satisfies Attach<M>,
  }
}
