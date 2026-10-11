import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const started = event("session-shell-started", {
  sessionID: "ses_1",
  shell: {
    id: "sh_1",
    status: "running",
    command: "pwd",
    cwd: "/tmp/ws",
    shell: "/bin/sh",
    file: "/tmp/sh_1.out",
    metadata: { sessionID: "ses_1", background: true },
    time: { started: 1 },
  },
})
// How the command ended and the output it left, as the host read them.
const outcome = {
  sessionID: "ses_1",
  shellID: "sh_1",
  outcome: "exited",
  exit: 0,
  output: { output: "/tmp/ws", cursor: 7, size: 7, truncated: false },
}
const settled = event("session-shell-settled", outcome)

export const settleShellSpec = createCommandSlice("settleShell")
  .description(
    "Settles a user's shell command in a live Session: how it ended, its exit code and the output it left. Only a shell the Session runs settles, and only once.",
  )
  .scenarios(
    {
      description: "A running shell settles with its outcome.",
      given: [created, started],
      when: outcome,
      expect: [settled],
    },
    {
      description: "A shell the Session never ran is refused.",
      given: [created],
      when: outcome,
      expect: [],
      reject: { code: "shell-not-running" },
    },
    {
      description: "A shell that has settled is refused.",
      given: [created, started, settled],
      when: outcome,
      expect: [],
      reject: { code: "shell-not-running" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: outcome,
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, started, deleted],
      when: outcome,
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default settleShellSpec
