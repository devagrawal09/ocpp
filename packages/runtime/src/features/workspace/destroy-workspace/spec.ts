import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("workspace-created", { workspaceID: "wrk_1", provider: "docker", time: 1 })
const destroyed = event("workspace-destroyed", { workspaceID: "wrk_1" })

export const destroyWorkspaceSpec = createCommandSlice("destroyWorkspace")
  .description(
    "Records that a workspace is gone, once the host has torn its backing resource down. Only a workspace that exists is destroyed, once.",
  )
  .scenarios(
    {
      description: "A workspace that exists is destroyed.",
      given: [created],
      when: { workspaceID: "wrk_1" },
      expect: [event("workspace-destroyed", { workspaceID: "wrk_1" })],
    },
    {
      description: "An unknown workspace is refused.",
      given: [],
      when: { workspaceID: "wrk_1" },
      expect: [],
      reject: { reason: "Workspace not found" },
    },
    {
      description: "A destroyed workspace is refused.",
      given: [created, destroyed],
      when: { workspaceID: "wrk_1" },
      expect: [],
      reject: { reason: "Workspace destroyed" },
    },
  )

export default destroyWorkspaceSpec
