// Spike harness: one Specter app per Session. Run with `bun bench/spike.ts` from this package.
// SESSIONS (default 200), TOKENS (300), DELAY_MS (2) and HISTORY_TURNS (200) tune the phases.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { deltaText, readLog, type LogRecord } from "../src/delta-log"
import { fakeModel } from "../src/fake-model"
import type { TurnMetrics } from "../src/run-turn"
import { closeAllSessionApps, openSessionApp } from "../src/session-app"

const sessions = Number(process.env.SESSIONS ?? 200)
const tokens = Number(process.env.TOKENS ?? 300)
const delayMs = Number(process.env.DELAY_MS ?? 2)
const historyTurns = Number(process.env.HISTORY_TURNS ?? 200)
const root = await mkdtemp(join(tmpdir(), "session-specter-spike-"))
const results: Record<string, unknown> = { bun: Bun.version, sessions, tokens, delayMs, root }
const ids = Array.from({ length: sessions }, (_, index) => `ses_${String(index).padStart(4, "0")}`)

// Phase 1: N concurrent Sessions, one turn each.
const metrics: TurnMetrics = { commitMs: [], tokens: 0, deltaWrites: 0 }
let peakRss = process.memoryUsage().rss
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 50)
const rssBefore = process.memoryUsage().rss
const wallStart = performance.now()
const turns = await Promise.all(
  ids.map(async (sessionId) => {
    const opening = performance.now()
    const session = await openSessionApp({ root, sessionId, model: fakeModel({ tokens, delayMs }), metrics })
    const openMs = performance.now() - opening
    const commits = [
      () => session.app.command({ type: "createSession", payload: { sessionId } }),
      () => session.app.command({ type: "enqueuePrompt", payload: { promptId: `prm_${sessionId}`, text: "hello" } }),
    ]
    const enqueued = performance.now()
    for (const commit of commits) {
      const started = performance.now()
      await Effect.runPromise(commit())
      metrics.commitMs.push(performance.now() - started)
    }
    await session.awaitIdle()
    return { openMs, turnMs: performance.now() - enqueued }
  }),
)
const wallMs = performance.now() - wallStart
clearInterval(sampler)
const statuses = await Promise.all(
  ids.map(async (sessionId) => {
    const session = await openSessionApp({ root, sessionId })
    return Effect.runPromise(session.app.query({ type: "sessionStatus", payload: {} }))
  }),
)
results.concurrency = {
  wallMs: round(wallMs),
  open: stats(turns.map((turn) => turn.openMs)),
  turn: stats(turns.map((turn) => turn.turnMs)),
  commit: stats(metrics.commitMs),
  commits: metrics.commitMs.length,
  rssBeforeMb: mb(rssBefore),
  rssPeakMb: mb(peakRss),
  rssAfterMb: mb(process.memoryUsage().rss),
  tokens: metrics.tokens,
  deltaWrites: metrics.deltaWrites,
  tokensPerDeltaWrite: round(metrics.tokens / metrics.deltaWrites),
  succeeded: statuses.filter((status) => status.succeeded === 1 && status.status === "idle").length,
}
const closing = performance.now()
await closeAllSessionApps()
results.closeAllMs = round(performance.now() - closing)

// Phase 2: reopen every Session, first with the persisted Reaction cursor, then replaying it from memory.
const reopen: Record<string, unknown> = {}
results.reopen = reopen
for (const reactionStore of ["jsonl", "memory"] as const) {
  const reopened = await Promise.all(
    ids.map(async (sessionId) => {
      const opening = performance.now()
      const session = await openSessionApp({ root, sessionId, reactionStore })
      const openMs = performance.now() - opening
      // Command and Query Slices use memory Stores, so the first read replays their projections.
      await Effect.runPromise(session.app.query({ type: "sessionMessages", payload: {} }))
      return { openMs, firstQueryMs: performance.now() - opening - openMs }
    }),
  )
  await closeAllSessionApps()
  // Sequential pass: per-Session reopen cost without 200 constructions competing for the event loop.
  const sequential: number[] = []
  for (const sessionId of ids) {
    const opening = performance.now()
    const session = await openSessionApp({ root, sessionId, reactionStore })
    await Effect.runPromise(session.app.query({ type: "sessionMessages", payload: {} }))
    sequential.push(performance.now() - opening)
  }
  await closeAllSessionApps()
  reopen[reactionStore] = {
    concurrentOpen: stats(reopened.map((entry) => entry.openMs)),
    concurrentFirstQuery: stats(reopened.map((entry) => entry.firstQueryMs)),
    sequentialOpenAndQuery: stats(sequential),
  }
}

// Phase 2b: one Session with a long history, to show Reaction replay cost on reopen.
{
  const session = await openSessionApp({ root, sessionId: "ses_history", model: fakeModel({ tokens: 3 }) })
  await Effect.runPromise(session.app.command({ type: "createSession", payload: { sessionId: "ses_history" } }))
  for (const turn of Array.from({ length: historyTurns }, (_, index) => index)) {
    await Effect.runPromise(
      session.app.command({ type: "enqueuePrompt", payload: { promptId: `prm_${turn}`, text: `turn ${turn}` } }),
    )
    await session.awaitIdle()
  }
  await session.close()
  const history = (await readLog(join(session.sessionDir, "events.jsonl"), 0)).records
  const reopenHistory = async (reactionStore: "jsonl" | "memory") => {
    const samples = []
    for (const _ of Array.from({ length: 5 })) {
      const opening = performance.now()
      const reopened = await openSessionApp({ root, sessionId: "ses_history", reactionStore })
      samples.push(performance.now() - opening)
      await reopened.close()
    }
    return stats(samples)
  }
  results.history = {
    turns: historyTurns,
    commits: history.length,
    events: history.reduce((count, record) => count + record.events.length, 0),
    reopenJsonlReaction: await reopenHistory("jsonl"),
    reopenMemoryReaction: await reopenHistory("memory"),
  }
}

// Phase 3: SIGKILL a worker mid-stream, restart it on the same root, and check the turn finishes once.
{
  const killRoot = join(root, "kill")
  const sessionDir = join(killRoot, "sessions", "ses_kill")
  const stepPath = join(sessionDir, "steps", "exe_prm_kill.jsonl")
  const worker = (mode: string) =>
    Bun.spawn(["bun", join(import.meta.dir, "turn-worker.ts"), killRoot, "ses_kill", mode], {
      stdout: "pipe",
      stderr: "pipe",
    })
  const first = worker("start")
  const deltasAtKill = await waitFor(async () => {
    const deltas = (await readLog(stepPath, 0)).records.flatMap((record) => record.events)
    const count = deltas.filter((event) => event.type === "text-delta").length
    return count >= 10 ? count : undefined
  }, 10_000)
  first.kill("SIGKILL")
  await first.exited
  const beforeRestart = eventTypes((await readLog(join(sessionDir, "events.jsonl"), 0)).records)
  const outboxAtKill = (await Bun.file(join(sessionDir, "outbox.jsonl")).text()).trim().split("\n").at(-1)
  const second = worker("resume")
  const exitCode = await Promise.race([second.exited, Bun.sleep(30_000).then(() => "timeout")])
  const events = (await readLog(join(sessionDir, "events.jsonl"), 0)).records
  const types = eventTypes(events)
  const finalTexts = events
    .flatMap((record) => record.events)
    .flatMap((event) => (event.type === "text-ended" ? [JSON.stringify(event.payload)] : []))
  const step = (await readLog(stepPath, 0)).records
  const outbox = (await Bun.file(join(sessionDir, "outbox.jsonl")).text()).trim().split("\n").at(-1)
  const stepText = deltaText(step)
  results.killRecover = {
    killedAfterDeltaRecords: deltasAtKill,
    killedExit: first.signalCode,
    eventsBeforeRestart: beforeRestart,
    outboxAtKill: outboxAtKill ? pick(JSON.parse(outboxAtKill), ["status", "attemptCount"]) : null,
    resumeExit: exitCode,
    resumeStderr: (await new Response(second.stderr).text()).slice(0, 500),
    eventsAfterRestart: types,
    executionSucceeded: types["execution-succeeded"] ?? 0,
    textEnded: types["text-ended"] ?? 0,
    distinctFinalTexts: new Set(finalTexts).size,
    stepAttempts: step.flatMap((record) => record.events).filter((event) => event.type === "attempt-started").length,
    stepTextMatchesTextEnded: finalTexts.length === 1 && JSON.parse(finalTexts[0]).text === stepText,
    outboxFinal: outbox ? pick(JSON.parse(outbox), ["status", "attemptCount", "lastError"]) : null,
    passed:
      exitCode === 0 &&
      types["execution-succeeded"] === 1 &&
      types["text-ended"] === 1 &&
      types["execution-started"] === 1,
  }
}

// Phase 4: tail a live step log from a mid-stream offset, disconnect, and resume from the last offset.
{
  const session = await openSessionApp({
    root,
    sessionId: "ses_tail",
    model: fakeModel({ tokens: 300, delayMs: 5 }),
    pollIntervalMs: 10,
  })
  const stepPath = join(session.sessionDir, "steps", "exe_prm_tail.jsonl")
  await Effect.runPromise(session.app.command({ type: "createSession", payload: { sessionId: "ses_tail" } }))
  await Effect.runPromise(session.app.command({ type: "enqueuePrompt", payload: { promptId: "prm_tail", text: "tail" } }))
  const prefix = await waitFor(async () => {
    const read = await readLog(stepPath, 0)
    return read.records.length >= 5 ? read : undefined
  }, 10_000)
  const seen: LogRecord[] = []
  const tail = async (offset: number, polls: number): Promise<number> => {
    const read = await readLog(stepPath, offset)
    seen.push(...read.records)
    const ended = read.records.some((record) => record.events.some((event) => event.type === "step-ended"))
    if (ended || polls <= 1) return read.offset
    await Bun.sleep(20)
    return tail(read.offset, polls - 1)
  }
  const disconnectedAt = await tail(prefix.offset, 8)
  const seenBeforeDisconnect = seen.length
  await Bun.sleep(300)
  await tail(disconnectedAt, 1_000)
  await session.awaitIdle()
  const full = (await readLog(stepPath, 0)).records
  const combined = [...prefix.records, ...seen]
  const versions = combined.map((record) => record.version)
  const messages = await Effect.runPromise(session.app.query({ type: "sessionMessages", payload: {} }))
  const recorded = messages.flatMap((message) =>
    message.role === "assistant" ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )
  results.deltaTail = {
    prefixRecords: prefix.records.length,
    seenBeforeDisconnect,
    seenAfterReconnect: seen.length - seenBeforeDisconnect,
    totalRecords: full.length,
    contiguous: versions.every((version, index) => version === index + 1),
    duplicates: versions.length - new Set(versions).size,
    matchesFile: JSON.stringify(combined) === JSON.stringify(full),
    textMatchesRecorded: deltaText(combined) === recorded[0],
  }
  await session.close()
}

console.log(JSON.stringify(results, null, 2))
await rm(root, { recursive: true, force: true })

function stats(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (quantile: number) => round(sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0)
  return { p50: at(0.5), p95: at(0.95), max: round(sorted.at(-1) ?? 0), n: sorted.length }
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function mb(bytes: number) {
  return round(bytes / 1024 / 1024)
}

function eventTypes(records: readonly LogRecord[]) {
  return records
    .flatMap((record) => record.events)
    .reduce<Record<string, number>>((counts, event) => ({ ...counts, [event.type]: (counts[event.type] ?? 0) + 1 }), {})
}

function pick(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}

async function waitFor<A>(check: () => Promise<A | undefined>, timeoutMs: number): Promise<A> {
  const deadline = performance.now() + timeoutMs
  const value = await check()
  if (value !== undefined) return value
  if (performance.now() > deadline) throw new Error("Timed out waiting for spike condition")
  await Bun.sleep(5)
  return waitFor(check, deadline - performance.now())
}
