import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("project-created", { projectID: "prj_1", canonical: "/repo", vcs: "git" })
const vcsChanged = (vcs?: string) =>
  event("project-vcs-changed", vcs ? { projectID: "prj_1", vcs } : { projectID: "prj_1" })
const relocated = (canonical: string) => event("project-relocated", { projectID: "prj_1", canonical })

export const resolveProjectSpec = createCommandSlice("resolveProject")
  .description(
    "Records a project as a directory resolved to it: its creation the first time, then what changed since. A project's version control may change or go away. Clones share a project ID, so a project moves to another canonical directory only when the host found the one it has gone. Nothing changed records nothing.",
  )
  .scenarios(
    {
      description: "A new project is created at its canonical directory, with its version control.",
      given: [],
      when: { projectID: "prj_1", canonical: "/repo", vcs: "git" },
      expect: [created],
    },
    {
      description: "A project without version control is created without it.",
      given: [],
      when: { projectID: "prj_1", canonical: "/repo" },
      expect: [event("project-created", { projectID: "prj_1", canonical: "/repo" })],
    },
    {
      description: "A project resolved as it is recorded is refused, and the host answers as done.",
      given: [created],
      when: { projectID: "prj_1", canonical: "/repo", vcs: "git" },
      expect: [],
      reject: { code: "project-unchanged" },
    },
    {
      description: "Another version control is recorded.",
      given: [created],
      when: { projectID: "prj_1", canonical: "/repo", vcs: "hg" },
      expect: [vcsChanged("hg")],
    },
    {
      description: "Version control that went away is recorded as none.",
      given: [created],
      when: { projectID: "prj_1", canonical: "/repo" },
      expect: [vcsChanged()],
    },
    {
      description: "A project whose canonical directory the host found gone moves to the one it resolved.",
      given: [created],
      when: { projectID: "prj_1", canonical: "/moved", vcs: "git", missing: "/repo" },
      expect: [relocated("/moved")],
    },
    {
      description: "A clone elsewhere keeps the canonical directory, which still exists.",
      given: [created],
      when: { projectID: "prj_1", canonical: "/clone", vcs: "git" },
      expect: [],
      reject: { code: "project-unchanged" },
    },
    {
      description: "A directory the host found gone that the project no longer has moves nothing.",
      given: [created, relocated("/moved")],
      when: { projectID: "prj_1", canonical: "/clone", vcs: "git", missing: "/repo" },
      expect: [],
      reject: { code: "project-unchanged" },
    },
    {
      description: "A change of version control and a move are one commit.",
      given: [created, vcsChanged()],
      when: { projectID: "prj_1", canonical: "/moved", vcs: "git", missing: "/repo" },
      expect: [vcsChanged("git"), relocated("/moved")],
    },
  )

export default resolveProjectSpec
