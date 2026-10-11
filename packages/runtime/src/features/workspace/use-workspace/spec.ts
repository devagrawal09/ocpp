import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("workspace-created", { workspaceID: "wrk_1", provider: "docker", time: 1 })
const destroyed = event("workspace-destroyed", { workspaceID: "wrk_1" })

export const useWorkspaceSpec = createCommandSlice("useWorkspace")
  .description(
    "Records when a workspace was last used: when a connection to it opened, or the last activity before it was suspended. Only a workspace that exists is used.",
  )
  .scenarios(
    {
      description: "A workspace that exists records when it was used.",
      given: [created],
      when: { workspaceID: "wrk_1", time: 5 },
      expect: [event("workspace-used", { workspaceID: "wrk_1", time: 5 })],
    },
    {
      description: "An unknown workspace is refused.",
      given: [],
      when: { workspaceID: "wrk_1", time: 5 },
      expect: [],
      reject: { code: "workspace-not-found" },
    },
    {
      description: "A destroyed workspace is refused.",
      given: [created, destroyed],
      when: { workspaceID: "wrk_1", time: 5 },
      expect: [],
      reject: { code: "workspace-destroyed" },
    },
  )

export default useWorkspaceSpec
