import { ProjectFact } from "@ocpp/schema/project-fact"
import { AbsolutePath, optional } from "@ocpp/schema/schema"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: each project's canonical directory and version
// control.
export type ResolveProjectState = {
  projects: Record<string, { canonical: string; vcs?: string }>
}

export const resolveProjectStore = Context.Service<
  SliceStoreService<ResolveProjectState, ResolveProjectState, unknown>
>("@ocpp/runtime/ResolveProjectStore")

export const createResolveProjectState = (): ResolveProjectState => ({ projects: {} })

const projectCreated = sessionEvent("project-created")
const vcsChanged = sessionEvent("project-vcs-changed")
const relocated = sessionEvent("project-relocated")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    ...ProjectFact.Created.data.fields,
    // The canonical directory the host found gone, which the project may move away from.
    missing: optional(AbsolutePath),
  }),
)

export const resolveProject = implementCommand(specification)
  .inputSchema(input)
  .store(resolveProjectStore)
  .consistencyKeys({ project: (command) => command.projectID })
  .apply(projectCreated, async (event, state) => {
    const { projectID, ...project } = event.payload
    state.projects[projectID] = project
  })
  .apply(vcsChanged, async (event, state) => {
    const project = state.projects[event.payload.projectID]
    if (!project) return
    if (event.payload.vcs === undefined) delete project.vcs
    else project.vcs = event.payload.vcs
  })
  .apply(relocated, async (event, state) => {
    const project = state.projects[event.payload.projectID]
    if (project) project.canonical = event.payload.canonical
  })
  .handle(async (command, state) => {
    const { missing, ...resolved } = command
    const project = state.projects[resolved.projectID]
    if (!project) return [projectCreated.create(resolved)]
    const facts = [
      ...(project.vcs === resolved.vcs
        ? []
        : [
            vcsChanged.create({
              projectID: resolved.projectID,
              ...(resolved.vcs === undefined ? {} : { vcs: resolved.vcs }),
            }),
          ]),
      ...(project.canonical !== resolved.canonical && project.canonical === missing
        ? [relocated.create({ projectID: resolved.projectID, canonical: resolved.canonical })]
        : []),
    ]
    if (facts.length === 0) throw new Error("Project unchanged")
    return facts
  })
