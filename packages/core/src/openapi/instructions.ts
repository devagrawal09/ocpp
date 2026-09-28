export * as OpenApiInstructions from "./instructions.js"

import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Instructions } from "../instructions/index.js"
import { ToolLists } from "../tool/lists.js"
import { OpenApi } from "./index.js"

const DESCRIPTION_LIMIT = 1_500

const Summary = Schema.Struct({
  namespace: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})
type Summary = typeof Summary.Type

const entries = (apis: ReadonlyArray<Summary>) =>
  apis.flatMap((api) => [
    `  <api name="${api.namespace}"${api.title === undefined ? "" : ` title=${JSON.stringify(api.title)}`}>`,
    api.error === undefined
      ? `    Call this REST API's operations through \`execute\` under \`tools[${JSON.stringify(api.namespace)}]\`. Its configured headers and credentials are sent automatically. A non-2xx response throws an error that includes the HTTP status and response body.`
      : `    This REST API is configured, but its operations are unavailable: ${api.error}`,
    ...(api.description ?? "").split("\n").flatMap((line) => (line.trim() === "" ? [] : [`    ${line}`])),
    "  </api>",
  ])

const render = (apis: ReadonlyArray<Summary>) => ["<openapi_apis>", ...entries(apis), "</openapi_apis>"].join("\n")

const update = (previous: ReadonlyArray<Summary>, current: ReadonlyArray<Summary>) => {
  const diff = Instructions.diffByKey(
    previous,
    current,
    (api) => api.namespace,
    (before, after) =>
      before.title !== after.title || before.description !== after.description || before.error !== after.error,
  )
  // Additions and removals render as small deltas; anything else restates the full list.
  if (diff.changed.length > 0 || (diff.added.length === 0 && diff.removed.length === 0))
    return ["The available REST APIs have changed. This list supersedes the previous one.", render(current)].join("\n")
  return [
    ...(diff.added.length === 0
      ? []
      : ["New REST APIs are available in addition to those previously listed:", ...entries(diff.added)]),
    ...(diff.removed.length === 0
      ? []
      : [`The following REST APIs are no longer available: ${diff.removed.map((api) => api.namespace).join(", ")}.`]),
  ].join("\n")
}

export interface Interface {
  /**
   * REST API guidance for a request whose Code Mode catalog holds these paths, selected by a tool list naming
   * `paths` (every tool when absent).
   */
  readonly load: (
    catalog: ReadonlyArray<string>,
    paths: ReadonlyArray<string> | undefined,
  ) => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/OpenApiInstructions") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const openapi = yield* OpenApi.Service

    return Service.of({
      load: Effect.fn("OpenApiInstructions.load")(function* (catalog, paths) {
        // An API is listed only when this request can reach one of its operations; an unavailable one is listed
        // when the tool list names its namespace, so the model can report why.
        const visible = (yield* openapi.apis())
          .filter((api) =>
            api.error === undefined
              ? catalog.some((path) => path.startsWith(api.namespace + "."))
              : ToolLists.includes(paths, api.namespace + ".") ||
                (paths ?? []).some((path) => path.startsWith(api.namespace + ".")),
          )
          .map((api) => ({
            namespace: api.namespace,
            ...(api.title === undefined ? {} : { title: api.title }),
            ...(api.description === undefined
              ? {}
              : {
                  description:
                    api.description.length > DESCRIPTION_LIMIT
                      ? api.description.slice(0, DESCRIPTION_LIMIT - 3) + "..."
                      : api.description,
                }),
            ...(api.error === undefined ? {} : { error: api.error }),
          }))
          .toSorted((a, b) => a.namespace.localeCompare(b.namespace))
        return Instructions.make<ReadonlyArray<Summary>>({
          key: Instructions.Key.make("core/openapi-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          read: Effect.succeed(visible.length === 0 ? Instructions.removed : visible),
          render: {
            initial: render,
            changed: update,
            removed: () => "REST API instructions are no longer available.",
          },
        })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [OpenApi.node] })
