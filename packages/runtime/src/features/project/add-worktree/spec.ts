import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("project-created", { projectID: "prj_1", canonical: "/repo", vcs: "git" })
const recorded = (strategy?: string) =>
  event(
    "worktree-recorded",
    strategy
      ? { projectID: "prj_1", directory: "/repo/feature", strategy }
      : { projectID: "prj_1", directory: "/repo/feature" },
  )
const removed = event("worktree-removed", { projectID: "prj_1", directory: "/repo/feature" })

export const addWorktreeSpec = createCommandSlice("addWorktree")
  .description(
    "Records a worktree the host created for a project, with the strategy that manages it. A directory the project holds under the same strategy records nothing.",
  )
  .scenarios(
    {
      description: "A new directory of the project is recorded with its strategy.",
      given: [created],
      when: { projectID: "prj_1", directory: "/repo/feature", strategy: "git" },
      expect: [recorded("git")],
    },
    {
      description: "A directory the project holds under the same strategy is refused, and the host answers as done.",
      given: [created, recorded("git")],
      when: { projectID: "prj_1", directory: "/repo/feature", strategy: "git" },
      expect: [],
      reject: { code: "worktree-unchanged" },
    },
    {
      description: "A directory the project holds under another strategy is recorded again.",
      given: [created, recorded()],
      when: { projectID: "prj_1", directory: "/repo/feature", strategy: "git" },
      expect: [recorded("git")],
    },
    {
      description: "A directory the project no longer holds is recorded again.",
      given: [created, recorded("git"), removed],
      when: { projectID: "prj_1", directory: "/repo/feature", strategy: "git" },
      expect: [recorded("git")],
    },
    {
      description: "A directory of an unknown project is refused.",
      given: [],
      when: { projectID: "prj_1", directory: "/repo/feature", strategy: "git" },
      expect: [],
      reject: { code: "project-not-found" },
    },
  )

export default addWorktreeSpec
