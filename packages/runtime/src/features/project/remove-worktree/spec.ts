import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("project-created", { projectID: "prj_1", canonical: "/repo", vcs: "git" })
const recorded = event("worktree-recorded", { projectID: "prj_1", directory: "/repo/feature", strategy: "git" })
const removed = event("worktree-removed", { projectID: "prj_1", directory: "/repo/feature" })

export const removeWorktreeSpec = createCommandSlice("removeWorktree")
  .description(
    "Records that a project no longer holds a worktree the host removed. A directory the project does not hold records nothing.",
  )
  .scenarios(
    {
      description: "A directory the project holds is removed.",
      given: [created, recorded],
      when: { projectID: "prj_1", directory: "/repo/feature" },
      expect: [removed],
    },
    {
      description: "A directory the project does not hold is refused, and the host answers as done.",
      given: [created, recorded, removed],
      when: { projectID: "prj_1", directory: "/repo/feature" },
      expect: [],
      reject: { reason: "Worktree not found" },
    },
    {
      description: "A directory of an unknown project is refused.",
      given: [],
      when: { projectID: "prj_1", directory: "/repo/feature" },
      expect: [],
      reject: { reason: "Project not found" },
    },
  )

export default removeWorktreeSpec
