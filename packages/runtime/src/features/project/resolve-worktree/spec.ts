import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("project-created", { projectID: "prj_1", canonical: "/repo", vcs: "git" })
const recorded = (directory = "/repo/feature") =>
  event("worktree-recorded", { projectID: "prj_1", directory, strategy: "git" })
const removed = event("worktree-removed", { projectID: "prj_1", directory: "/repo/feature" })
const resolution = { projectID: "prj_1", directory: "/repo/feature", previous: "global" }

export const resolveWorktreeSpec = createCommandSlice("resolveWorktree")
  .description(
    "Resolves a directory to the project it belongs to, and records it as the project's directory. The resolution moves the Sessions the directory held, under the project it had before or the markerless projects it adopts, to this project. A directory the project holds is resolved already.",
  )
  .scenarios(
    {
      description: "A new directory of a project is resolved and recorded, in one commit.",
      given: [created],
      when: { ...resolution, strategy: "git" },
      expect: [event("worktree-resolved", resolution), recorded()],
    },
    {
      description: "The projects the directory adopts are named, and a directory without a strategy records none.",
      given: [created],
      when: { ...resolution, directory: "/repo", adopted: ["prj_markerless"] },
      expect: [
        event("worktree-resolved", { ...resolution, directory: "/repo", adopted: ["prj_markerless"] }),
        event("worktree-recorded", { projectID: "prj_1", directory: "/repo" }),
      ],
    },
    {
      description: "A directory the project holds is resolved already.",
      given: [created, recorded()],
      when: { ...resolution, strategy: "git" },
      expect: [],
      reject: { code: "worktree-already-resolved" },
    },
    {
      description: "A directory the project no longer holds is resolved again.",
      given: [created, recorded(), removed],
      when: { ...resolution, strategy: "git" },
      expect: [event("worktree-resolved", resolution), recorded()],
    },
    {
      description: "A directory of an unknown project is refused.",
      given: [],
      when: { ...resolution, strategy: "git" },
      expect: [],
      reject: { code: "project-not-found" },
    },
  )

export default resolveWorktreeSpec
