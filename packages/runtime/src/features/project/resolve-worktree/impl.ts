import { ProjectFact } from "@ocpp/schema/project-fact"
import { Worktree } from "@ocpp/schema/worktree"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the projects the log has created, and the
// directories each holds.
export type ResolveWorktreeState = {
  projects: Record<string, Record<string, true>>
}

export const resolveWorktreeStore = Context.Service<
  SliceStoreService<ResolveWorktreeState, ResolveWorktreeState, unknown>
>("@ocpp/runtime/ResolveWorktreeStore")

export const createResolveWorktreeState = (): ResolveWorktreeState => ({ projects: {} })

const projectCreated = sessionEvent("project-created")
const worktreeRecorded = sessionEvent("worktree-recorded")
const worktreeRemoved = sessionEvent("worktree-removed")
const worktreeResolved = sessionEvent("worktree-resolved")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    ...Worktree.Event.Resolved.data.fields,
    // How the directory is managed as a worktree, if it is one.
    strategy: ProjectFact.WorktreeRecorded.data.fields.strategy,
  }),
)

export const resolveWorktree = implementCommand(specification)
  .inputSchema(input)
  .store(resolveWorktreeStore)
  .consistencyKeys((command) => [command.projectID])
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
    const { strategy, ...resolution } = command
    const project = state.projects[resolution.projectID]
    if (!project) throw new Error("Project not found")
    if (project[resolution.directory]) throw new Error("Worktree already resolved")
    return [
      worktreeResolved.create(resolution),
      worktreeRecorded.create({
        projectID: resolution.projectID,
        directory: resolution.directory,
        ...(strategy === undefined ? {} : { strategy }),
      }),
    ]
  })
