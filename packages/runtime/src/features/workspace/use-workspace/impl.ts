import { ProjectFact } from "@ocpp/schema/project-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every workspace ID the log has named, existing or
// destroyed. Duplicated from the other workspace Slices on purpose.
export type UseWorkspaceState = {
  workspaces: Record<string, "live" | "destroyed">
}

export const useWorkspaceStore = Context.Service<SliceStoreService<UseWorkspaceState, UseWorkspaceState, unknown>>(
  "@ocpp/runtime/UseWorkspaceStore",
)

export const createUseWorkspaceState = (): UseWorkspaceState => ({ workspaces: {} })

const workspaceCreated = sessionEvent("workspace-created")
const workspaceDestroyed = sessionEvent("workspace-destroyed")
const recorded = sessionEvent("workspace-used")

const input = Schema.toStandardSchemaV1(ProjectFact.WorkspaceUsed.data)

export const useWorkspace = implementCommand(specification)
  .inputSchema(input)
  .store(useWorkspaceStore)
  .consistencyKeys((command) => [command.workspaceID])
  .apply(workspaceCreated, async (event, state) => {
    state.workspaces[event.payload.workspaceID] = "live"
  })
  .apply(workspaceDestroyed, async (event, state) => {
    state.workspaces[event.payload.workspaceID] = "destroyed"
  })
  .handle(async (command, state) => {
    const workspace = state.workspaces[command.workspaceID]
    if (!workspace) throw new Error("Workspace not found")
    if (workspace === "destroyed") throw new Error("Workspace destroyed")
    return [recorded.create(command)]
  })
