import { createCommandSlice, event } from "@specter-ts/spec"

const created = (provider = "docker") => event("workspace-created", { workspaceID: "wrk_1", provider, time: 1 })
const destroyed = event("workspace-destroyed", { workspaceID: "wrk_1" })

export const createWorkspaceSpec = createCommandSlice("createWorkspace")
  .description(
    "Commits a logical workspace ID for a provider, before any provider work. An ID names one workspace at a time: the same provider's workspace exists already, and another provider's is refused. A destroyed workspace's ID can be created again.",
  )
  .scenarios(
    {
      description: "A new workspace is created for its provider.",
      given: [],
      when: { workspaceID: "wrk_1", provider: "docker", time: 1 },
      expect: [created()],
    },
    {
      description: "The provider's workspace exists already, and the host answers with its ID.",
      given: [created()],
      when: { workspaceID: "wrk_1", provider: "docker", time: 2 },
      expect: [],
      reject: { reason: "Workspace already exists" },
    },
    {
      description: "Another provider's workspace under the ID is refused.",
      given: [created()],
      when: { workspaceID: "wrk_1", provider: "e2b", time: 2 },
      expect: [],
      reject: { reason: "Workspace belongs to another provider" },
    },
    {
      description: "A destroyed workspace's ID is created again.",
      given: [created(), destroyed],
      when: { workspaceID: "wrk_1", provider: "e2b", time: 1 },
      expect: [created("e2b")],
    },
  )

export default createWorkspaceSpec
