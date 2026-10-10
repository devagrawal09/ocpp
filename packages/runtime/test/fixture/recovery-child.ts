// Child process for session-recovery.test.ts: "app A". Starts a step that never
// finishes, reports when it is in flight, and waits to be killed (SIGKILL), so
// the process dies without any shutdown path.
import { ProjectID } from "@ocpp/schema/project-id"
import { AbsolutePath } from "@ocpp/schema/schema"
import { SessionID } from "@ocpp/schema/session-id"

import { Effect } from "effect"

import { sessionEvent } from "../../src/events.ts"
import { openJsonlRuntime } from "./jsonl-runtime.ts"
import { makeScriptedStepHost } from "./scripted-step-host.ts"

const directory = process.argv[2]
// Mode `tool`: the step requests a call that never settles, so the process
// dies with a running tool call in durable history.
const mode = process.argv[3] ?? "step"
if (!directory) throw new Error("usage: recovery-child.ts <directory> [tool]")

const host = makeScriptedStepHost()
const never = new Promise<void>(() => {})
// The first step blocks forever: it stays in flight.
host.script(
  "ses_1",
  mode === "tool"
    ? [{ finish: "tool-calls", toolCalls: [{ id: "call_1", name: "execute", gate: never }] }]
    : [{ finish: "tool-calls", gate: never }],
)

const { runtime, log } = await openJsonlRuntime({
  directory,
  host,
  outbox: { worker: { leaseMs: 300 } },
})
const stepStarts = () =>
  Effect.runSync(log.query(0, [mode === "tool" ? "session-tool-requested" : "session-step-started"])).length
// A restarted child (same directory) resumes the work of the one before it:
// it reports only once a further step has started.
const before = stepStarts()
if (Effect.runSync(log.currentVersion) === 0) {
  await Effect.runPromise(
    log.append([
      sessionEvent("session-created").create({
        sessionID: SessionID.make("ses_1"),
        projectID: ProjectID.make("prj_1"),
        location: { directory: AbsolutePath.make("/tmp/ws") },
        slug: "brave-otter",
        version: "2",
      }),
    ]),
  )
  await Effect.runPromise(
    runtime.command({
      type: "enqueueInput",
      payload: {
        sessionID: "ses_1",
        inboxID: "msg_a",
        type: "user",
        payload: { text: "prompt msg_a" },
      },
    }),
  )
}

while (stepStarts() <= before) await new Promise((resolve) => setTimeout(resolve, 5))
process.stdout.write("in-flight\n")
setInterval(() => {}, 1 << 30)
