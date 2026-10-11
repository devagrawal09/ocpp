import { ProjectFact } from "@ocpp/schema/project-fact"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the projects the log has created, and the
// directories each holds with their strategy ("" for none). Duplicated from
// the other worktree Slices on purpose.
export type AddWorktreeState = {
  projects: Record<string, Record<string, string>>
}

export const addWorktreeStore = Context.Service<SliceStoreService<AddWorktreeState, AddWorktreeState, unknown>>(
  "@ocpp/runtime/AddWorktreeStore",
)

export const createAddWorktreeState = (): AddWorktreeState => ({ projects: {} })

const projectCreated = sessionEvent("project-created")
const worktreeRecorded = sessionEvent("worktree-recorded")
const worktreeRemoved = sessionEvent("worktree-removed")

const input = Schema.toStandardSchemaV1(ProjectFact.WorktreeRecorded.data)

export const addWorktree = implementCommand(specification)
  .inputSchema(input)
  .store(addWorktreeStore)
  .consistencyKeys({ project: (command) => command.projectID })
  .apply(projectCreated, async (event, state) => {
    state.projects[event.payload.projectID] ??= {}
  })
  .apply(worktreeRecorded, async (event, state) => {
    const project = state.projects[event.payload.projectID]
    if (project) project[event.payload.directory] = event.payload.strategy ?? ""
  })
  .apply(worktreeRemoved, async (event, state) => {
    delete state.projects[event.payload.projectID]?.[event.payload.directory]
  })
  .handle(async (command, state) => {
    const project = state.projects[command.projectID]
    if (!project) throw new CommandRejection("project-not-found", "Project not found")
    if (project[command.directory] === (command.strategy ?? ""))
      throw new CommandRejection("worktree-unchanged", "Worktree unchanged")
    return [worktreeRecorded.create(command)]
  })
