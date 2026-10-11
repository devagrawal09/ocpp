import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("project-created", { projectID: "prj_1", canonical: "/repo", vcs: "git" })
const recorded = (directory: string, strategy?: string) =>
  event("worktree-recorded", strategy ? { projectID: "prj_1", directory, strategy } : { projectID: "prj_1", directory })
const removed = (directory: string) => event("worktree-removed", { projectID: "prj_1", directory })

export const refreshWorktreesSpec = createCommandSlice("refreshWorktrees")
  .description(
    "Brings a project's directories up to date with what the host found on disk, in one commit: each directory found that the project does not hold, or holds under another strategy, is recorded, and each one the host found gone is removed. A refresh that changes nothing records nothing.",
  )
  .scenarios(
    {
      description: "New and changed directories are recorded and gone ones removed, in one commit.",
      given: [created, recorded("/repo"), recorded("/repo/a"), recorded("/repo/b", "git"), recorded("/repo/c", "git")],
      when: {
        projectID: "prj_1",
        found: [
          { directory: "/repo" },
          { directory: "/repo/a", strategy: "git" },
          { directory: "/repo/b", strategy: "git" },
          { directory: "/repo/d", strategy: "git" },
        ],
        gone: ["/repo/c"],
      },
      expect: [recorded("/repo/a", "git"), recorded("/repo/d", "git"), removed("/repo/c")],
    },
    {
      description: "A directory found gone that the project does not hold is not removed.",
      given: [created, recorded("/repo/c", "git"), removed("/repo/c")],
      when: { projectID: "prj_1", found: [{ directory: "/repo/d", strategy: "git" }], gone: ["/repo/c"] },
      expect: [recorded("/repo/d", "git")],
    },
    {
      description: "A refresh that changes nothing is refused, and the host answers as done.",
      given: [created, recorded("/repo")],
      when: { projectID: "prj_1", found: [{ directory: "/repo" }], gone: ["/repo/c"] },
      expect: [],
      reject: { reason: "Worktrees unchanged" },
    },
    {
      description: "An unknown project is refused.",
      given: [],
      when: { projectID: "prj_1", found: [{ directory: "/repo" }], gone: [] },
      expect: [],
      reject: { reason: "Project not found" },
    },
  )

export default refreshWorktreesSpec
