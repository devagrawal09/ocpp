export * as ProjectProjector from "./projector.js"

import { ProjectFact } from "@ocpp/schema/project-fact"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { and, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { WorkspaceTable } from "../workspace/sql.js"
import { WorktreeTable } from "../worktree/sql.js"
import { ProjectTable } from "./sql.js"

/**
 * Projects, their worktrees and workspaces are projections of their facts in Specter's Event Log, written
 * in the transaction that records each fact.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    const run = <A extends { readonly run: () => Effect.Effect<unknown, unknown> }>(query: A) =>
      query.run().pipe(Effect.orDie, Effect.asVoid)

    yield* bus.project(ProjectFact.Created, (event) =>
      run(
        db
          .insert(ProjectTable)
          .values({
            id: event.data.projectID,
            worktree: event.data.canonical,
            vcs: event.data.vcs,
            sandboxes: [],
            time_created: event.created,
            time_updated: event.created,
          })
          .onConflictDoNothing(),
      ),
    )
    yield* bus.project(ProjectFact.VcsChanged, (event) =>
      run(
        db
          .update(ProjectTable)
          .set({ vcs: event.data.vcs ?? null, time_updated: event.created })
          .where(eq(ProjectTable.id, event.data.projectID)),
      ),
    )
    yield* bus.project(ProjectFact.Relocated, (event) =>
      run(
        db
          .update(ProjectTable)
          .set({ worktree: event.data.canonical, time_updated: event.created })
          .where(eq(ProjectTable.id, event.data.projectID)),
      ),
    )
    yield* bus.project(ProjectFact.Edited, (event) =>
      run(
        db
          .update(ProjectTable)
          .set({
            name: event.data.name === undefined ? undefined : event.data.name || null,
            icon_url_override: event.data.icon?.override === undefined ? undefined : event.data.icon.override || null,
            icon_color: event.data.icon?.color === undefined ? undefined : event.data.icon.color || null,
            commands:
              event.data.commands?.start === undefined
                ? undefined
                : event.data.commands.start
                  ? { start: event.data.commands.start }
                  : null,
            time_updated: event.created,
          })
          .where(eq(ProjectTable.id, event.data.projectID)),
      ),
    )

    yield* bus.project(ProjectFact.WorktreeRecorded, (event) =>
      run(
        db
          .insert(WorktreeTable)
          .values({
            project_id: event.data.projectID,
            directory: event.data.directory,
            strategy: event.data.strategy,
            time_created: event.created,
          })
          .onConflictDoUpdate({
            target: [WorktreeTable.project_id, WorktreeTable.directory],
            set: { strategy: event.data.strategy ?? null },
          }),
      ),
    )
    yield* bus.project(ProjectFact.WorktreeRemoved, (event) =>
      run(
        db
          .delete(WorktreeTable)
          .where(
            and(eq(WorktreeTable.project_id, event.data.projectID), eq(WorktreeTable.directory, event.data.directory)),
          ),
      ),
    )

    yield* bus.project(ProjectFact.WorkspaceCreated, (event) =>
      run(
        db
          .insert(WorkspaceTable)
          .values({
            id: event.data.workspaceID,
            provider: event.data.provider,
            binding: null,
            created_at: event.data.time,
            last_used_at: event.data.time,
          })
          .onConflictDoNothing(),
      ),
    )
    yield* bus.project(ProjectFact.WorkspaceBound, (event) =>
      run(
        db
          .update(WorkspaceTable)
          .set({ binding: event.data.binding })
          .where(eq(WorkspaceTable.id, event.data.workspaceID)),
      ),
    )
    yield* bus.project(ProjectFact.WorkspaceUsed, (event) =>
      run(
        db
          .update(WorkspaceTable)
          .set({ last_used_at: event.data.time })
          .where(eq(WorkspaceTable.id, event.data.workspaceID)),
      ),
    )
    yield* bus.project(ProjectFact.WorkspaceDestroyed, (event) =>
      run(db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, event.data.workspaceID))),
    )
  }),
)

export const node = makeGlobalNode({
  name: "project-projector",
  layer,
  deps: [Bus.node, Database.node],
})
