import { ProjectFact } from "@ocpp/schema/project-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the provider of each workspace that exists.
export type CreateWorkspaceState = {
  workspaces: Record<string, string>
}

export const createWorkspaceStore = Context.Service<
  SliceStoreService<CreateWorkspaceState, CreateWorkspaceState, unknown>
>("@ocpp/runtime/CreateWorkspaceStore")

export const createCreateWorkspaceState = (): CreateWorkspaceState => ({ workspaces: {} })

const workspaceCreated = sessionEvent("workspace-created")
const workspaceDestroyed = sessionEvent("workspace-destroyed")

const input = Schema.toStandardSchemaV1(ProjectFact.WorkspaceCreated.data)

export const createWorkspace = implementCommand(specification)
  .inputSchema(input)
  .store(createWorkspaceStore)
  .apply(workspaceCreated, async (event, state) => {
    state.workspaces[event.payload.workspaceID] = event.payload.provider
  })
  .apply(workspaceDestroyed, async (event, state) => {
    delete state.workspaces[event.payload.workspaceID]
  })
  .handle(async (command, state) => {
    const provider = state.workspaces[command.workspaceID]
    if (provider === command.provider) throw new Error("Workspace already exists")
    if (provider !== undefined) throw new Error("Workspace belongs to another provider")
    return [workspaceCreated.create(command)]
  })
