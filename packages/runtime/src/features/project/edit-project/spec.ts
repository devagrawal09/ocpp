import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("project-created", { projectID: "prj_1", canonical: "/repo", vcs: "git" })
const edit = { projectID: "prj_1", name: "Repo", icon: { color: "blue" }, commands: { start: "bun install" } }

export const editProjectSpec = createCommandSlice("editProject")
  .description(
    "Records a user's edit of a project's name, icon or start command; an empty value clears one. Only a project the log created is edited.",
  )
  .scenarios(
    {
      description: "A project's name, icon and commands are edited.",
      given: [created],
      when: edit,
      expect: [event("project-edited", edit)],
    },
    {
      description: "An unknown project is refused.",
      given: [],
      when: edit,
      expect: [],
      reject: { reason: "Project not found" },
    },
  )

export default editProjectSpec
