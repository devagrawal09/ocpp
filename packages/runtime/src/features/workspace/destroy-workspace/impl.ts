import { ProjectFact } from "@ocpp/schema/project-fact"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every workspace ID the log has named, existing or
// destroyed. Duplicated from the other workspace Slices on purpose.
export type DestroyWorkspaceState = {
  workspaces: Record<string, "live" | "destroyed">
}

export const destroyWorkspaceStore = Context.Service<
  SliceStoreService<DestroyWorkspaceState, DestroyWorkspaceState, unknown>
>("@ocpp/runtime/DestroyWorkspaceStore")

export const createDestroyWorkspaceState = (): DestroyWorkspaceState => ({ workspaces: {} })

const workspaceCreated = sessionEvent("workspace-created")
const workspaceDestroyed = sessionEvent("workspace-destroyed")
const recorded = sessionEvent("workspace-destroyed")

const input = Schema.toStandardSchemaV1(ProjectFact.WorkspaceDestroyed.data)

export const destroyWorkspace = implementCommand(specification)
  .inputSchema(input)
  .store(destroyWorkspaceStore)
  .consistencyKeys({ workspace: (command) => command.workspaceID })
  .apply(workspaceCreated, async (event, state) => {
    state.workspaces[event.payload.workspaceID] = "live"
  })
  .apply(workspaceDestroyed, async (event, state) => {
    state.workspaces[event.payload.workspaceID] = "destroyed"
  })
  .handle(async (command, state) => {
    const workspace = state.workspaces[command.workspaceID]
    if (!workspace) throw new CommandRejection("workspace-not-found", "Workspace not found")
    if (workspace === "destroyed") throw new CommandRejection("workspace-destroyed", "Workspace destroyed")
    return [recorded.create(command)]
  })
