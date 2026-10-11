import { createCommandSlice, event } from "@specter-ts/spec"

const program = { version: 1, source: "const a = 1" }
const limits = { values: 3, bytes: 100 }
const admitted = (executionID: string, reserved: string[], sessionID = "ses_1") =>
  event("session-codemode-execution-admitted", {
    sessionID,
    executionID,
    assistantMessageID: "msg_1",
    toolCallID: `call_${executionID}`,
    program,
    snapshot: [],
    reserved,
  })
const finished = (executionID: string, values: Record<string, string | number>, sessionID = "ses_1") =>
  event("session-codemode-execution-settled", { sessionID, executionID, outcome: "finished", values })
const failed = (executionID: string, error: string) =>
  event("session-codemode-execution-settled", { sessionID: "ses_1", executionID, outcome: "failed", error })
const discarded = event("session-codemode-execution-discarded", { sessionID: "ses_1", executionID: "exe_2" })

export const settleCodeModeExecutionSpec = createCommandSlice("settleCodeModeExecution")
  .description(
    "Settles a Code Mode execution once. A finished program saves the values of its declarations into its Session's notebook when the execution still holds their names and they fit the notebook; otherwise it fails and saves nothing, with why. A program that failed, or whose outcome is indeterminate, releases its names and saves nothing. A revert that cuts an execution's message settles it as it commits.",
  )
  .scenarios(
    {
      description: "A finished program saves its declarations.",
      given: [admitted("exe_2", ["b"])],
      when: { executionID: "exe_2", outcome: "finished", values: { b: 2 }, limits },
      expect: [finished("exe_2", { b: 2 })],
    },
    {
      description: "A program that failed settles with its error.",
      given: [admitted("exe_2", ["b"])],
      when: { executionID: "exe_2", outcome: "failed", error: "Boom", limits },
      expect: [failed("exe_2", "Boom")],
    },
    {
      description: "An execution whose outcome is unknown settles as indeterminate.",
      given: [admitted("exe_2", ["b"])],
      when: { executionID: "exe_2", outcome: "indeterminate", error: "Host restarted", limits },
      expect: [
        event("session-codemode-execution-settled", {
          sessionID: "ses_1",
          executionID: "exe_2",
          outcome: "indeterminate",
          error: "Host restarted",
        }),
      ],
    },
    {
      description: "A value whose name the execution does not hold fails it, saving nothing.",
      given: [admitted("exe_2", ["b"])],
      when: { executionID: "exe_2", outcome: "finished", values: { b: 2, c: 3 }, limits },
      expect: [failed("exe_2", "Notebook names c are no longer reserved by this execution; nothing was saved.")],
    },
    {
      description: "Values that would hold more than the notebook's number of values fail it, saving nothing.",
      given: [admitted("exe_1", ["a", "b"]), finished("exe_1", { a: 1, b: 2 }), admitted("exe_2", ["c", "d"])],
      when: { executionID: "exe_2", outcome: "finished", values: { c: 3, d: 4 }, limits },
      expect: [
        failed(
          "exe_2",
          "This Session's notebook would hold 4 values, above the limit of 3. Notebook names are permanent, so free space by reverting messages that saved values you no longer need. Nothing was saved.",
        ),
      ],
    },
    {
      description: "Values that would hold more than the notebook's bytes fail it, saving nothing.",
      given: [admitted("exe_2", ["b"])],
      when: { executionID: "exe_2", outcome: "finished", values: { b: "x".repeat(99) }, limits },
      expect: [
        failed(
          "exe_2",
          "This Session's notebook would hold 101 bytes, above the limit of 100. Publish smaller summaries and keep large artifacts in files through host tools. Nothing was saved.",
        ),
      ],
    },
    {
      description: "A fork holds only the values it copied, and values a revert removed leave room.",
      given: [
        admitted("exe_3", ["x", "y"], "ses_0"),
        finished("exe_3", { x: 1, y: 2 }, "ses_0"),
        admitted("exe_4", ["z"], "ses_0"),
        finished("exe_4", { z: 3 }, "ses_0"),
        event("session-codemode-notebook-copied", { sessionID: "ses_1", parentID: "ses_0", executions: ["exe_4"] }),
        admitted("exe_1", ["a", "b"]),
        finished("exe_1", { a: 1, b: 2 }),
        event("session-codemode-notebook-reverted", { sessionID: "ses_1", executions: ["exe_1"] }),
        admitted("exe_2", ["c", "d"]),
      ],
      when: { executionID: "exe_2", outcome: "finished", values: { c: 3, d: 4 }, limits },
      expect: [finished("exe_2", { c: 3, d: 4 })],
    },
    {
      description: "An execution that settled is refused, and the host reports how it settled.",
      given: [admitted("exe_2", ["b"]), failed("exe_2", "Boom")],
      when: { executionID: "exe_2", outcome: "finished", values: { b: 2 }, limits },
      expect: [],
      reject: { code: "execution-already-settled" },
    },
    {
      description: "An execution never admitted, or discarded, is refused.",
      given: [admitted("exe_2", ["b"]), discarded],
      when: { executionID: "exe_2", outcome: "finished", values: { b: 2 }, limits },
      expect: [],
      reject: { code: "execution-not-found" },
    },
  )

export default settleCodeModeExecutionSpec
