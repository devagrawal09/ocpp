import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("workspace-created", { workspaceID: "wrk_1", provider: "docker", time: 1 })
const destroyed = event("workspace-destroyed", { workspaceID: "wrk_1" })

export const bindWorkspaceSpec = createCommandSlice("bindWorkspace")
  .description(
    "Records the provider's binding to a workspace's backing resource, as the provider gave it, once it is provisioned or changes. Only a workspace that exists is bound.",
  )
  .scenarios(
    {
      description: "A workspace that exists is bound to its resource.",
      given: [created],
      when: { workspaceID: "wrk_1", binding: { containerID: "c_1" } },
      expect: [event("workspace-bound", { workspaceID: "wrk_1", binding: { containerID: "c_1" } })],
    },
    {
      description: "An unknown workspace is refused.",
      given: [],
      when: { workspaceID: "wrk_1", binding: { containerID: "c_1" } },
      expect: [],
      reject: { code: "workspace-not-found" },
    },
    {
      description: "A destroyed workspace is refused.",
      given: [created, destroyed],
      when: { workspaceID: "wrk_1", binding: { containerID: "c_1" } },
      expect: [],
      reject: { code: "workspace-destroyed" },
    },
  )

export default bindWorkspaceSpec
