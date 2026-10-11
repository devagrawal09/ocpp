import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
// The shell the host started for the user's command.
const shell = {
  id: "sh_1",
  status: "running",
  command: "pwd",
  cwd: "/tmp/ws",
  shell: "/bin/sh",
  file: "/tmp/sh_1.out",
  metadata: { sessionID: "ses_1", background: true },
  time: { started: 1 },
}
const started = event("session-shell-started", { sessionID: "ses_1", shell })
const settled = event("session-shell-settled", {
  sessionID: "ses_1",
  shellID: "sh_1",
  outcome: "exited",
  exit: 0,
  output: { output: "/tmp/ws", cursor: 7, size: 7, truncated: false },
})

export const runShellSpec = createCommandSlice("runShell")
  .description(
    "Records a user's shell command running in a live Session, once the host has started it: the shell's timeline entry starts here and settles with settleShell. A shell runs once.",
  )
  .scenarios(
    {
      description: "The shell the host started runs in the Session.",
      given: [created],
      when: { sessionID: "ses_1", shell },
      expect: [started],
    },
    {
      description: "A shell that is already running is refused.",
      given: [created, started],
      when: { sessionID: "ses_1", shell },
      expect: [],
      reject: { code: "shell-already-started" },
    },
    {
      description: "A shell that has settled is refused too: its ID names one run.",
      given: [created, started, settled],
      when: { sessionID: "ses_1", shell },
      expect: [],
      reject: { code: "shell-already-started" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1", shell },
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: { sessionID: "ses_1", shell },
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default runShellSpec
