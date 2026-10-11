import { ProjectFact } from "@ocpp/schema/project-fact"
import { AbsolutePath } from "@ocpp/schema/schema"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the projects the log has created, and the
// directories each holds with their strategy ("" for none). Duplicated from
// the other worktree Slices on purpose.
export type RefreshWorktreesState = {
  projects: Record<string, Record<string, string>>
}

export const refreshWorktreesStore = Context.Service<
  SliceStoreService<RefreshWorktreesState, RefreshWorktreesState, unknown>
>("@ocpp/runtime/RefreshWorktreesStore")

export const createRefreshWorktreesState = (): RefreshWorktreesState => ({ projects: {} })

const projectCreated = sessionEvent("project-created")
const worktreeRecorded = sessionEvent("worktree-recorded")
const worktreeRemoved = sessionEvent("worktree-removed")

const { projectID, ...found } = ProjectFact.WorktreeRecorded.data.fields

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    projectID,
    // The directories the host found, each with the strategy that manages it, if any.
    found: Schema.Array(Schema.Struct(found)),
    // The directories the host found gone.
    gone: Schema.Array(AbsolutePath),
  }),
)

export const refreshWorktrees = implementCommand(specification)
  .inputSchema(input)
  .store(refreshWorktreesStore)
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
    const facts = [
      ...command.found
        .filter((item) => project[item.directory] !== (item.strategy ?? ""))
        .map((item) => worktreeRecorded.create({ projectID: command.projectID, ...item })),
      ...command.gone
        .filter((directory) => project[directory] !== undefined)
        .map((directory) => worktreeRemoved.create({ projectID: command.projectID, directory })),
    ]
    if (facts.length === 0) throw new CommandRejection("worktrees-unchanged", "Worktrees unchanged")
    return facts
  })
