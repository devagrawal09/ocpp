import { Bus } from "@ocpp/core/bus"
import { Database } from "@ocpp/core/database/database"
import { Project } from "@ocpp/core/project"
import { ProjectProjector } from "@ocpp/core/project/projector"
import { ProjectTable } from "@ocpp/core/project/sql"
import { ProjectFact } from "@ocpp/schema/project-fact"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"

export const globalProjectNode = makeGlobalNode({
  service: Project.Service,
  layer: Layer.effect(
    Project.Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      return Project.Service.of({
        list: () => Effect.succeed([]),
        update: () => Effect.die("not implemented"),
        resolve: (directory) =>
          Effect.gen(function* () {
            const project = { id: Project.ID.global, directory, canonical: directory }
            const stored = yield* db
              .select({ id: ProjectTable.id })
              .from(ProjectTable)
              .where(eq(ProjectTable.id, project.id))
              .get()
              .pipe(Effect.orDie)
            if (!stored) yield* bus.publish(ProjectFact.Created, { projectID: project.id, canonical: directory })
            return project
          }),
      })
    }),
  ),
  deps: [Database.node, Bus.node, ProjectProjector.node],
})
