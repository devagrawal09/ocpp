export * as ProjectFact from "./project-fact.js"

import { Schema } from "effect"
import { Event } from "./event.js"
import { Project } from "./project.js"
import { ProjectID } from "./project-id.js"
import { AbsolutePath, NonNegativeInt, optional } from "./schema.js"
import { WorkspaceID } from "./workspace-id.js"

const byProject = { aggregate: "projectID" } as const

/** A project was first resolved, at its canonical directory. */
export const Created = Event.durable({
  type: "project-created",
  durable: byProject,
  schema: { projectID: ProjectID, canonical: AbsolutePath, vcs: optional(Project.Vcs) },
})
/** The project's version control changed, or went away. */
export const VcsChanged = Event.durable({
  type: "project-vcs-changed",
  durable: byProject,
  schema: { projectID: ProjectID, vcs: optional(Project.Vcs) },
})
/** The project's canonical directory moved: the one it had is gone. */
export const Relocated = Event.durable({
  type: "project-relocated",
  durable: byProject,
  schema: { projectID: ProjectID, canonical: AbsolutePath },
})
/** A user edited the project's name, icon or commands; an empty value clears one. */
export const Edited = Event.durable({
  type: "project-edited",
  durable: byProject,
  schema: Project.UpdateInput.fields,
})
/** A directory of the project is stored, with the strategy that manages it as a worktree, if any. */
export const WorktreeRecorded = Event.durable({
  type: "worktree-recorded",
  durable: byProject,
  schema: { projectID: ProjectID, directory: AbsolutePath, strategy: optional(Schema.String) },
})
export const WorktreeRemoved = Event.durable({
  type: "worktree-removed",
  durable: byProject,
  schema: { projectID: ProjectID, directory: AbsolutePath },
})

const byWorkspace = { aggregate: "workspaceID" } as const

export const WorkspaceCreated = Event.durable({
  type: "workspace-created",
  durable: byWorkspace,
  schema: { workspaceID: WorkspaceID, provider: Schema.String, time: NonNegativeInt },
})
/** The provider's binding to the workspace's backing resource, stored as the provider gave it. */
export const WorkspaceBound = Event.durable({
  type: "workspace-bound",
  durable: byWorkspace,
  schema: { workspaceID: WorkspaceID, binding: Schema.Record(Schema.String, Schema.Json) },
})
export const WorkspaceUsed = Event.durable({
  type: "workspace-used",
  durable: byWorkspace,
  schema: { workspaceID: WorkspaceID, time: NonNegativeInt },
})
export const WorkspaceDestroyed = Event.durable({
  type: "workspace-destroyed",
  durable: byWorkspace,
  schema: { workspaceID: WorkspaceID },
})

/**
 * Internal persistence facts of projects, their worktrees and workspaces. OC++'s project, worktree and
 * workspace rows are their projections; clients see the ordinary notifications (`project-updated`,
 * `worktree-updated`).
 */
export const Definitions = Event.inventory(
  Created,
  VcsChanged,
  Relocated,
  Edited,
  WorktreeRecorded,
  WorktreeRemoved,
  WorkspaceCreated,
  WorkspaceBound,
  WorkspaceUsed,
  WorkspaceDestroyed,
)
