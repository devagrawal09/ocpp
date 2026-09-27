import type { LocationRef, SessionInfo, SessionMessageInfo, ShellInfo } from "@ocpp/client/promise"
import { ExternalSession } from "@ocpp/schema/external-session"
import { SessionDriver } from "@ocpp/schema/session-driver"

/** How the Running view stops an item, through a cancel path that already exists for it. */
export type RunningStop =
  | { type: "execution"; sessionID: string; executionID: string }
  | { type: "shell"; shellID: string; location: LocationRef }
  | { type: "subagent"; sessionID: string }

export type RunningItem = {
  /** Stable across updates: the tool call or invocation's execution, the shell, or the child session. */
  id: string
  kind: "execution" | "shell" | "subagent"
  /** The code's first line, the shell command, or the subagent's task description. */
  label: string
  /** The event or command that ran this execution instead of the model. */
  trigger?: { type: "event" | "command"; name: string }
  agent?: string
  /** The child session's title, when it differs from the label. */
  title?: string
  /** The vendor agent that drives a subagent, and whether this call runs it in its native harness. */
  driver?: { id: ExternalSession.Provider; native: boolean }
  started: number
  /** Code Mode progress: the trace's step count and the tool it is calling now. */
  steps?: number
  tool?: string
  /** A subagent's child session is taking a step, rather than waiting on its own runs. */
  working?: boolean
  /** The execution this item runs inside. */
  parent?: string
  /** Where the timeline shows the item: a turn, or the row with one of its parts. */
  target?: { messageID: string; partID?: string }
  /** The subagent's child session. */
  child?: string
  stop?: RunningStop
  /** When a finished item still lingers, the time it was last seen running. */
  finished?: number
}

type ToolEvent = {
  tool: string
  status: string
  input: Record<string, unknown>
  metadata: Record<string, unknown>
}

/** A running execution and the tool calls in its trace. */
type Run = { item: RunningItem; events: ToolEvent[] }

/** How long a finished item stays in the list, so a short run is still seen ending. */
export const lingerMs = 4_000

/**
 * Everything running in a Session, from the state the app already receives: Code Mode executions of the
 * model and of events and commands, the subagents and shell commands they started, and child sessions
 * or shell commands that run on their own. An item another one runs follows that one.
 */
export function runningItems(input: {
  sessionID: string
  messages: readonly SessionMessageInfo[]
  sessions: readonly SessionInfo[]
  status: (sessionID: string) => "idle" | "running"
  shells: readonly (ShellInfo & { location: LocationRef })[]
}) {
  const children = new Map(
    input.sessions
      .filter((session) => session.parentID === input.sessionID && !session.fork)
      .map((session) => [session.id, session]),
  )
  const runs = input.messages.flatMap((message): Run[] => {
    if (message.type === "invocation") {
      if (message.status !== "running") return []
      const events = toolEvents(message.events)
      return [
        {
          item: {
            id: message.executionID,
            kind: "execution",
            label: firstLine(message.code),
            trigger: { type: message.trigger.type, name: message.trigger.name },
            started: message.time.created,
            ...progress(events, message.events?.length ?? 0),
            target: { messageID: message.id },
            stop: { type: "execution", sessionID: input.sessionID, executionID: message.executionID },
          },
          events,
        },
      ]
    }
    if (message.type !== "assistant") return []
    return message.content.flatMap((part) => {
      if (part.type !== "tool" || part.name !== "execute" || part.state.status === "streaming") return []
      const metadata = part.state.metadata ?? {}
      if (part.state.status !== "running" && metadata.executionStatus !== "running") return []
      const executionID = typeof metadata.executionID === "string" ? metadata.executionID : undefined
      const events = toolEvents(metadata.events)
      return [
        {
          item: {
            // The tool call's ID, which it keeps once the execution it starts has an ID of its own.
            id: part.id,
            kind: "execution",
            label: firstLine(typeof part.state.input.code === "string" ? part.state.input.code : ""),
            started: part.time.ran ?? part.time.created,
            ...progress(events, Array.isArray(metadata.events) ? metadata.events.length : 0),
            target: { messageID: message.id, partID: part.id },
            ...(executionID ? { stop: { type: "execution", sessionID: input.sessionID, executionID } } : {}),
          },
          events,
        },
      ]
    })
  })

  const subagents = runs.flatMap((run) =>
    run.events.flatMap((event, index): RunningItem[] => {
      if (event.tool !== "subagent" || event.status !== "running") return []
      const childID = typeof event.metadata.sessionID === "string" ? event.metadata.sessionID : undefined
      const child = childID ? children.get(childID) : undefined
      // The child's model names its driver once it exists; until then the call's explicit choice does.
      const driven = child?.model ? SessionDriver.of(child.model) : text(event.input.driver)
      const working = childID ? input.status(childID) === "running" : undefined
      const label = text(event.input.description) ?? text(event.input.prompt) ?? text(event.input.message)
      return [
        {
          id: childID ?? `${run.item.id}:${index}`,
          kind: "subagent",
          label: label ? firstLine(label) : (child?.title ?? event.tool),
          agent: text(event.input.agent) ?? child?.agent,
          ...(child?.title && child.title !== label ? { title: child.title } : {}),
          ...vendor(driven, event.input.harness === "native"),
          // A continued subagent's session is older than this call, which started within the execution.
          started: Math.max(run.item.started, child?.time.created ?? 0),
          ...(working === undefined ? {} : { working }),
          parent: run.item.id,
          target: run.item.target,
          ...(childID ? { child: childID } : {}),
          // Interrupting a child session stops its step; one waiting on its own runs has none to stop.
          ...(childID && working ? { stop: { type: "subagent" as const, sessionID: childID } } : {}),
        },
      ]
    }),
  )
  const claimed = new Set(subagents.map((item) => item.id))
  const detached = [...children.values()].flatMap((child): RunningItem[] => {
    if (claimed.has(child.id) || input.status(child.id) !== "running") return []
    return [
      {
        id: child.id,
        kind: "subagent",
        label: child.title ?? child.id,
        ...(child.agent ? { agent: child.agent } : {}),
        // Without a subagent call to ask for another harness, a vendor child runs in the OC++ harness.
        ...vendor(child.model ? SessionDriver.of(child.model) : undefined, false),
        started: child.time.created,
        working: true,
        child: child.id,
        stop: { type: "subagent", sessionID: child.id },
      },
    ]
  })

  const shells = input.shells.flatMap((shell): RunningItem[] => {
    if (shell.status !== "running" || shell.metadata.sessionID !== input.sessionID) return []
    const owner = runs.find((run) => run.events.some((event) => event.metadata.shellID === shell.id))
    // The user's own shell commands have a message; a background command outlives the execution that started it.
    const message = input.messages.find((item) => item.type === "shell" && item.shellID === shell.id)
    const target =
      owner?.item.target ??
      (message
        ? { messageID: message.id }
        : input.messages
            .flatMap(traces)
            .find((trace) => trace.events.some((event) => event.metadata.shellID === shell.id))?.target)
    return [
      {
        id: shell.id,
        kind: "shell",
        label: firstLine(shell.command),
        started: shell.time.started,
        ...(owner ? { parent: owner.item.id } : {}),
        ...(target ? { target } : {}),
        stop: { type: "shell", shellID: shell.id, location: shell.location },
      },
    ]
  })

  return arrange([...runs.map((run) => run.item), ...subagents, ...detached, ...shells])
}

/**
 * Keeps items that stopped running in the list for `lingerMs`, marked finished, so the list does not
 * jump the moment something ends.
 */
export function linger(previous: readonly RunningItem[], running: readonly RunningItem[], now: number) {
  const current = new Set(running.map((item) => item.id))
  const finished = previous.flatMap((item) => {
    if (current.has(item.id)) return []
    const at = item.finished ?? now
    return now - at < lingerMs ? [{ ...item, finished: at, stop: undefined }] : []
  })
  return arrange([...running, ...finished])
}

/** Top-level items oldest first, each followed by the items it runs. */
export function arrange(items: readonly RunningItem[]) {
  const ids = new Set(items.map((item) => item.id))
  const byStart = (a: RunningItem, b: RunningItem) => a.started - b.started
  return items
    .filter((item) => !item.parent || !ids.has(item.parent))
    .toSorted(byStart)
    .flatMap((item) => [item, ...items.filter((child) => child.parent === item.id).toSorted(byStart)])
}

/** A compact running time: seconds, then minutes and seconds, then hours and minutes. */
export function formatElapsed(
  ms: number,
  t: (
    key: "ui.message.duration.seconds" | "ui.message.duration.minutesSeconds" | "session.running.duration.hoursMinutes",
    params: Record<string, string | number>,
  ) => string,
) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return t("ui.message.duration.seconds", { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return t("ui.message.duration.minutesSeconds", { minutes, seconds: String(seconds % 60).padStart(2, "0") })
  return t("session.running.duration.hoursMinutes", {
    hours: Math.floor(minutes / 60),
    minutes: String(minutes % 60).padStart(2, "0"),
  })
}

/** Each execution a message shows, running or not, with the tool calls in its trace. */
function traces(message: SessionMessageInfo) {
  if (message.type === "invocation") return [{ target: { messageID: message.id }, events: toolEvents(message.events) }]
  if (message.type !== "assistant") return []
  return message.content.flatMap((part) =>
    part.type === "tool" && part.name === "execute" && part.state.status !== "streaming"
      ? [{ target: { messageID: message.id, partID: part.id }, events: toolEvents(part.state.metadata?.events) }]
      : [],
  )
}

function vendor(driver: string | undefined, native: boolean): Pick<RunningItem, "driver"> {
  const id = ExternalSession.Provider.literals.find((provider) => provider === driver)
  return id === undefined ? {} : { driver: { id, native } }
}

function progress(events: readonly ToolEvent[], steps: number) {
  const tool = events.findLast((event) => event.status === "running")?.tool
  return { steps, ...(tool ? { tool } : {}) }
}

function firstLine(value: string) {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  )
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

// Trace entries arrive as JSON from tool metadata, so each tool call is checked before it is read.
function toolEvents(value: unknown): ToolEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((event: unknown) => {
    if (!record(event) || event.type !== "tool" || typeof event.tool !== "string") return []
    return [
      {
        tool: event.tool,
        status: typeof event.status === "string" ? event.status : "",
        input: record(event.input) ? event.input : {},
        metadata: record(event.metadata) ? event.metadata : {},
      },
    ]
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
