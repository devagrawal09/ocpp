import { ProjectFact } from "@ocpp/schema/project-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the projects the log has created, and the
// directories each holds. Duplicated from the other worktree Slices on
// purpose.
export type RemoveWorktreeState = {
  projects: Record<string, Record<string, true>>
}

export const removeWorktreeStore = Context.Service<
  SliceStoreService<RemoveWorktreeState, RemoveWorktreeState, unknown>
>("@ocpp/runtime/RemoveWorktreeStore")

export const createRemoveWorktreeState = (): RemoveWorktreeState => ({ projects: {} })

const projectCreated = sessionEvent("project-created")
const worktreeRecorded = sessionEvent("worktree-recorded")
const worktreeRemoved = sessionEvent("worktree-removed")

const input = Schema.toStandardSchemaV1(ProjectFact.WorktreeRemoved.data)

export const removeWorktree = implementCommand(specification)
  .inputSchema(input)
  .store(removeWorktreeStore)
  .apply(projectCreated, async (event, state) => {
    state.projects[event.payload.projectID] ??= {}
  })
  .apply(worktreeRecorded, async (event, state) => {
    const project = state.projects[event.payload.projectID]
    if (project) project[event.payload.directory] = true
  })
  .apply(worktreeRemoved, async (event, state) => {
    delete state.projects[event.payload.projectID]?.[event.payload.directory]
  })
  .handle(async (command, state) => {
    const project = state.projects[command.projectID]
    if (!project) throw new Error("Project not found")
    if (!project[command.directory]) throw new Error("Worktree not found")
    return [worktreeRemoved.create(command)]
  })
