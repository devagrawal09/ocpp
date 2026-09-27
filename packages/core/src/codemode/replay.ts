export * as CodeModeReplay from "./replay.js"

import { type CodeMode, isToolHandle, toolExpression } from "@ocpp/codemode"
import { Effect } from "effect"
import { limits } from "./limits.js"
import type { CodeModeStore } from "./store.js"

/** What a resumed run may do with a journaled call of a tool, looked up by tool path. */
export type Policy = (path: string) => { readonly readOnly: boolean; readonly reattach: boolean } | undefined

/** How one tool call runs: served from the journal, or run by the tool, possibly rejoining its earlier work. */
export type Decision =
  | { readonly type: "live"; readonly recovered?: Readonly<Record<string, unknown>> }
  | { readonly type: "replay"; readonly entry: CodeModeStore.JournalEntry }

const live: Decision = { type: "live" }

/** `tools.search` runs inside the interpreter against the catalog, so running it again has no effect. */
const search = { readOnly: true, reattach: false }

/**
 * Why a journal cannot be replayed safely with the current tools, or undefined when it can. Checked
 * before a resumed run starts, so an unsafe resume never runs any code or tool.
 */
export function refusal(journal: ReadonlyArray<CodeModeStore.JournalEntry>, policy: Policy) {
  return journal.map((entry) => entryRefusal(entry, policy)).find((reason) => reason !== undefined)
}

function entryRefusal(entry: CodeModeStore.JournalEntry, policy: Policy) {
  const rules = entry.tool === "search" ? search : policy(entry.tool)
  const call = "Call " + (entry.index + 1) + " (" + toolExpression(entry.tool) + ")"
  if (rules === undefined)
    return call + " cannot be replayed because " + toolExpression(entry.tool) + " is no longer available."
  if (inFlight(entry) && !rules.readOnly && !(rules.reattach && entry.progress !== undefined))
    return (
      call +
      " was running when the server stopped, so it may or may not have taken effect, and it is not safe to run again automatically."
    )
  if (!inFlight(entry) && entry.omitted && !rules.readOnly)
    return (
      call +
      " exceeded the " +
      limits.maxCaptureBytes / 1024 +
      " KiB journal capture limit, so its result cannot be replayed, and it is not safe to run again automatically."
    )
  return undefined
}

/**
 * Follows one execution through its journal. Calls that settled before the restart are served from
 * the journal and impure values are fed back in order, so the program reaches the same state without
 * calling tools again. The first call the journal has no settled result for runs live, and so does
 * everything after it. Any difference between the program and the journal stops the run instead of
 * guessing.
 */
export function make(journal: ReadonlyArray<CodeModeStore.JournalEntry>, policy: Policy) {
  const decisions = new Map<number, Decision>()
  // Index of the next call the program will start, and impure values read since the previous call.
  let position = 0
  let reads = 0
  let pending: Array<number> = []
  let replayed = 0
  let divergence: string | undefined

  const diverge = (reason: string) => {
    divergence ??=
      "Replaying its journal after the server restarted diverged: " +
      reason +
      " Replay stopped there, and no tool ran after it."
  }

  return {
    /** Supplies `time.now()` and `Math.random()`, replaying journaled values before live ones. */
    impure: (helper: CodeMode.ImpureHelper) => {
      const logged = journal[position]?.impure[reads]
      reads++
      if (logged !== undefined) return logged
      const entry = journal[position]
      if (entry !== undefined)
        diverge("the program read " + helper + "() more often before " + describe(entry) + " than it did originally.")
      const value = helper === "time.now" ? Date.now() : Math.random()
      pending.push(value)
      return value
    },
    /**
     * Decides how a starting call runs and returns the impure values to journal with it. Runs in the
     * call-start hook, before the tool is resolved to its host implementation.
     */
    start: (call: CodeMode.ToolCallStarted) => {
      const entry = journal[call.index]
      const impure = pending
      const segment = reads
      pending = []
      reads = 0
      position = call.index + 1
      if (divergence !== undefined || entry === undefined) {
        decisions.set(call.index, live)
        return { impure, replayed: false }
      }
      const mismatch =
        segment !== entry.impure.length
          ? "the program read time.now() or Math.random() " +
            segment +
            " times before " +
            describe(entry) +
            ", but " +
            entry.impure.length +
            " times originally."
          : call.name !== entry.tool
            ? "the program made call " +
              (call.index + 1) +
              " to " +
              toolExpression(call.name) +
              ", but originally made it to " +
              toolExpression(entry.tool) +
              "."
            : !entry.omitted && JSON.stringify(journalValue(call.input)) !== JSON.stringify(entry.input)
              ? "the program made " + describe(entry) + " with different input than it did originally."
              : undefined
      if (mismatch !== undefined) {
        diverge(mismatch)
        return { impure, replayed: false }
      }
      if (!inFlight(entry) && !entry.omitted) {
        replayed++
        decisions.set(call.index, { type: "replay", entry })
        return { impure, replayed: true }
      }
      const rules = policy(entry.tool)
      decisions.set(
        call.index,
        rules !== undefined && !rules.readOnly && rules.reattach && entry.progress !== undefined
          ? { type: "live", recovered: entry.progress }
          : live,
      )
      return { impure, replayed: false }
    },
    /** How a host tool call runs. A diverged run is interrupted here, before the tool can run. */
    call: (index: number): Effect.Effect<Decision> =>
      divergence === undefined ? Effect.succeed(decisions.get(index) ?? live) : Effect.interrupt,
    /** Why the replay diverged from the journal, checked once the program stops. */
    divergence: () => {
      const unreached = journal[position]
      if (divergence === undefined && unreached !== undefined)
        diverge("the program stopped before reaching " + describe(unreached) + ", which it made originally.")
      return divergence
    },
    /** Calls served from the journal instead of running again. */
    replayed: () => replayed,
  }
}

/**
 * The JSON form of a call input stored in the journal and compared on replay. Tool handles are
 * recorded by their definitions, which a program derives deterministically.
 */
export function journalValue(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, item) => (isToolHandle(item) ? { toolHandle: item.definition } : item)) ?? "null",
  )
}

function inFlight(entry: CodeModeStore.JournalEntry) {
  return entry.status === "scheduled" || entry.status === "indeterminate"
}

function describe(entry: CodeModeStore.JournalEntry) {
  return "call " + (entry.index + 1) + " (" + toolExpression(entry.tool) + ")"
}
