import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const executionStarted = event("session-execution-started", { sessionID: "ses_1" })
const executionSettled = event("session-execution-settled", { sessionID: "ses_1", outcome: "succeeded" })
const step = { sessionID: "ses_1", assistantMessageID: "msg_a1" }
const stepStarted = event("session-step-started", {
  ...step,
  agent: "build",
  model: { id: "sonnet", providerID: "claude" },
})
const requested = (id: string) =>
  event("session-tool-requested", { ...step, id, name: "Read", input: { path: "a.txt" }, executed: true })
const toolSettled = (id: string) =>
  event("session-tool-settled", {
    ...step,
    id,
    content: [{ type: "text", text: "contents" }],
    executed: true,
    outcome: "succeeded",
  })
const usage = { cost: 0.01, tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } }
const unanswered = { type: "unknown", message: "External tool ended without a result" }
const succeeded = { outcome: "succeeded", finish: "stop", ...usage }
const blocks = [
  { kind: "reasoning", ordinal: 0, text: "Thinking" },
  { kind: "text", ordinal: 0, text: "Done" },
]

export const finishAgentStepSpec = createCommandSlice("finishAgentStep")
  .description(
    "Finishes the step an external agent produced, in one commit: its finished blocks, a failure for each call the agent left without a result, and the step's settlement with what it spent. The agent's own failure settles only the step: the host decides whether its execution goes on. Only the step in flight in a running execution finishes.",
  )
  .scenarios(
    {
      description: "The step's blocks are recorded, then the step settles.",
      given: [created, executionStarted, stepStarted],
      when: { ...step, blocks, calls: [], ...succeeded },
      expect: [
        event("session-block-recorded", { ...step, ...blocks[0] }),
        event("session-block-recorded", { ...step, ...blocks[1] }),
        event("session-step-settled", { ...step, ...succeeded }),
      ],
    },
    {
      description: "A call left without a result fails with the step, in the same commit.",
      given: [created, executionStarted, stepStarted, requested("call_1")],
      when: { ...step, blocks: [], calls: [{ id: "call_1", executed: true, error: unanswered }], ...succeeded },
      expect: [
        event("session-tool-settled", { ...step, id: "call_1", outcome: "failed", executed: true, error: unanswered }),
        event("session-step-settled", { ...step, ...succeeded }),
      ],
    },
    {
      description: "A call that settled meanwhile is not settled again.",
      given: [created, executionStarted, stepStarted, requested("call_1"), toolSettled("call_1")],
      when: { ...step, blocks: [], calls: [{ id: "call_1", executed: true, error: unanswered }], ...succeeded },
      expect: [event("session-step-settled", { ...step, ...succeeded })],
    },
    {
      description: "The agent's failure settles the step as failed, with what it spent.",
      given: [created, executionStarted, stepStarted],
      when: {
        ...step,
        blocks: [],
        calls: [],
        outcome: "failed",
        error: { type: "provider.error", message: "Overloaded" },
        ...usage,
      },
      expect: [
        event("session-step-settled", {
          ...step,
          outcome: "failed",
          error: { type: "provider.error", message: "Overloaded" },
          ...usage,
        }),
      ],
    },
    {
      description: "A step that never started is refused.",
      given: [created, executionStarted],
      when: { ...step, blocks: [], calls: [], ...succeeded },
      expect: [],
      reject: { code: "step-not-in-flight" },
    },
    {
      description: "A step that settled (an interrupt aborted it) is refused.",
      given: [
        created,
        executionStarted,
        stepStarted,
        event("session-step-settled", {
          ...step,
          outcome: "failed",
          error: { type: "aborted", message: "Interrupted" },
        }),
      ],
      when: { ...step, blocks: [], calls: [], ...succeeded },
      expect: [],
      reject: { code: "step-not-in-flight" },
    },
    {
      description: "A step whose execution has settled is refused.",
      given: [created, executionStarted, stepStarted, executionSettled],
      when: { ...step, blocks: [], calls: [], ...succeeded },
      expect: [],
      reject: { code: "execution-not-active" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { ...step, blocks: [], calls: [], ...succeeded },
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: { ...step, blocks: [], calls: [], ...succeeded },
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default finishAgentStepSpec
