import { ProjectFact } from "@ocpp/schema/project-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the projects the log has created.
export type EditProjectState = {
  projects: Record<string, true>
}

export const editProjectStore = Context.Service<SliceStoreService<EditProjectState, EditProjectState, unknown>>(
  "@ocpp/runtime/EditProjectStore",
)

export const createEditProjectState = (): EditProjectState => ({ projects: {} })

const projectCreated = sessionEvent("project-created")
const projectEdited = sessionEvent("project-edited")

const input = Schema.toStandardSchemaV1(ProjectFact.Edited.data)

export const editProject = implementCommand(specification)
  .inputSchema(input)
  .store(editProjectStore)
  .consistencyKeys({ project: (command) => command.projectID })
  .apply(projectCreated, async (event, state) => {
    state.projects[event.payload.projectID] = true
  })
  .handle(async (command, state) => {
    if (!state.projects[command.projectID]) throw new Error("Project not found")
    return [projectEdited.create(command)]
  })
