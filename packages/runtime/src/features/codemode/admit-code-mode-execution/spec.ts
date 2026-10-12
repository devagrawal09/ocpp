import { createCommandSlice, event } from "@specter-ts/spec"

const created = (sessionID = "ses_1") =>
  event("session-created", {
    sessionID,
    projectID: "prj_1",
    location: { directory: "/tmp/ws" },
    slug: sessionID,
    version: "2",
  })
const deleted = event("session-deleted", { sessionID: "ses_1" })
const program = { version: 1, source: "const a = 1" }
const limits = { values: 3, bytes: 100 }
const admission = (executionID: string, reserved: string[], sessionID = "ses_1") => ({
  sessionID,
  executionID,
  assistantMessageID: "msg_1",
  toolCallID: `call_${executionID}`,
  program,
  reserved,
})
const admitted = (executionID: string, reserved: string[], snapshot: string[] = [], sessionID = "ses_1") =>
  event("session-codemode-execution-admitted", { ...admission(executionID, reserved, sessionID), snapshot })
const saved = (executionID: string, values: Record<string, string | number>, sessionID = "ses_1") =>
  event("session-codemode-execution-settled", { sessionID, executionID, outcome: "finished", values })
const failed = (executionID: string) =>
  event("session-codemode-execution-settled", {
    sessionID: "ses_1",
    executionID,
    outcome: "failed",
    error: "Boom",
  })
const discarded = (executionID: string) =>
  event("session-codemode-execution-discarded", { sessionID: "ses_1", executionID })

export const admitCodeModeExecutionSpec = createCommandSlice("admitCodeModeExecution")
  .description(
    "Admits a Code Mode program in a live Session: it reserves every name the program declares, so the execution alone may save them, and it sees the notebook as it is now. A program whose names the notebook holds, or another running execution reserved, is refused, and so is one that would grow the notebook past its limits. An execution's ID is refused while it runs; the host generates every one, so a settled execution is forgotten.",
  )
  .scenarios(
    {
      description: "A program is admitted with the notebook it sees and the names it reserves.",
      given: [created(), admitted("exe_1", ["a"]), saved("exe_1", { a: 1 })],
      when: { ...admission("exe_2", ["b"]), limits },
      expect: [admitted("exe_2", ["b"], ["a"])],
    },
    {
      description: "A name the notebook holds is refused: notebook names are immutable.",
      given: [created(), admitted("exe_1", ["a"]), saved("exe_1", { a: 1 })],
      when: { ...admission("exe_2", ["a"]), limits },
      expect: [],
      reject: { code: "name-already-defined", details: { names: ["a"] } },
    },
    {
      description: "A name another execution reserved is refused until it settles.",
      given: [created(), admitted("exe_1", ["a"])],
      when: { ...admission("exe_2", ["a"]), limits },
      expect: [],
      reject: { code: "name-reserved", details: { names: ["a"], owner: "exe_1" } },
    },
    {
      description: "An execution that settled without saving releases its names.",
      given: [created(), admitted("exe_1", ["a"]), failed("exe_1")],
      when: { ...admission("exe_2", ["a"]), limits },
      expect: [admitted("exe_2", ["a"])],
    },
    {
      description: "A discarded execution releases its names.",
      given: [created(), admitted("exe_1", ["a"]), discarded("exe_1")],
      when: { ...admission("exe_2", ["a"]), limits },
      expect: [admitted("exe_2", ["a"])],
    },
    {
      description: "A program that would grow the notebook past its number of values is refused.",
      given: [created(), admitted("exe_1", ["a", "b"]), saved("exe_1", { a: 1, b: 2 })],
      when: { ...admission("exe_2", ["c", "d"]), limits },
      expect: [],
      reject: { code: "notebook-full", details: { values: 4, bytes: 2 } },
    },
    {
      description: "A notebook past its bytes admits nothing more.",
      given: [created(), admitted("exe_1", ["a"]), saved("exe_1", { a: "x".repeat(120) })],
      when: { ...admission("exe_2", ["b"]), limits },
      expect: [],
      reject: { code: "notebook-full", details: { values: 2, bytes: 122 } },
    },
    {
      description: "Values a revert removed free their names and their room.",
      given: [
        created(),
        admitted("exe_1", ["a", "b"]),
        saved("exe_1", { a: 1, b: 2 }),
        event("session-codemode-notebook-reverted", { sessionID: "ses_1", executions: ["exe_1"] }),
      ],
      when: { ...admission("exe_2", ["a", "c"]), limits },
      expect: [admitted("exe_2", ["a", "c"])],
    },
    {
      description:
        "A fork holds the values its notebook copy carries, the parent's saved through the boundary, and nothing reserved.",
      given: [
        created(),
        admitted("exe_1", ["a"]),
        saved("exe_1", { a: 1 }),
        admitted("exe_2", ["b"]),
        saved("exe_2", { b: 2 }),
        admitted("exe_3", ["c"]),
        created("ses_2"),
        event("session-codemode-notebook-copied", {
          sessionID: "ses_2",
          values: { a: { value: 1, executionID: "exe_1", seq: 1 } },
          commands: {},
          events: {},
        }),
      ],
      when: { ...admission("exe_4", ["b", "c"], "ses_2"), limits },
      expect: [admitted("exe_4", ["b", "c"], ["a"], "ses_2")],
    },
    {
      description:
        "A fork's notebook is its copy's, whatever is left of its parent: with its parent purged, a copied name is still defined.",
      given: [
        created("ses_2"),
        event("session-codemode-notebook-copied", {
          sessionID: "ses_2",
          values: { a: { value: 1, executionID: "exe_1", seq: 1 } },
          commands: {},
          events: {},
        }),
      ],
      when: { ...admission("exe_4", ["a"], "ses_2"), limits },
      expect: [],
      reject: { code: "name-already-defined", details: { names: ["a"] } },
    },
    {
      description: "An execution ID names one execution while it runs: admitting it again is refused.",
      given: [created(), admitted("exe_1", ["a"])],
      when: { ...admission("exe_1", ["b"]), limits },
      expect: [],
      reject: { code: "execution-already-admitted" },
    },
    {
      description:
        "A settled execution is forgotten: the host generates every execution's ID, so the check is the executions that run.",
      given: [created(), admitted("exe_1", ["a"]), failed("exe_1")],
      when: { ...admission("exe_1", ["b"]), limits },
      expect: [admitted("exe_1", ["b"])],
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { ...admission("exe_1", ["a"]), limits },
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created(), deleted],
      when: { ...admission("exe_1", ["a"]), limits },
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default admitCodeModeExecutionSpec
