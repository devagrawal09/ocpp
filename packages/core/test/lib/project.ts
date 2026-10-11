import { Bus } from "@ocpp/core/bus"
import { Project } from "@ocpp/core/project"
import { ProjectProjector } from "@ocpp/core/project/projector"
import { SpecterRejection } from "@ocpp/core/specter/rejection"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Effect, Layer } from "effect"

export const globalProjectNode = makeGlobalNode({
  service: Project.Service,
  layer: Layer.effect(
    Project.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      return Project.Service.of({
        list: () => Effect.succeed([]),
        update: () => Effect.die("not implemented"),
        resolve: (directory) =>
          Effect.gen(function* () {
            const project = { id: Project.ID.global, directory, canonical: directory }
            // The first directory resolved creates the global project; later ones change nothing.
            yield* bus
              .command({ type: "resolveProject", payload: { projectID: project.id, canonical: directory } })
              .pipe(
                Effect.catchIf(
                  (error) => SpecterRejection.reason(error) === "Project unchanged",
                  () => Effect.void,
                ),
                Effect.orDie,
              )
            return project
          }),
      })
    }),
  ),
  deps: [Bus.node, ProjectProjector.node],
})
