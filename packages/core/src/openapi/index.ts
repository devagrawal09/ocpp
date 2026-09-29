export * as OpenApi from "./index.js"

import { ToolFailure } from "@ocpp/ai"
import { isRecord } from "@ocpp/ai/utils/record"
import { OpenAPI } from "@ocpp/codemode"
import { type Document, Event } from "@ocpp/schema/config"
import type { ConfigOpenAPI } from "@ocpp/schema/config/openapi"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { httpClient } from "@ocpp/util/effect/app-node-platform"
import { FSUtil } from "@ocpp/util/fs-util"
import { Global } from "@ocpp/util/global"
import { Context, Effect, Fiber, type JsonSchema, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import path from "path"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Location } from "../location.js"
import { Tool } from "../tool.js"

/** One configured API: its operations as registrations, or why its document is unusable. */
export interface Api {
  readonly namespace: string
  readonly title?: string
  readonly description?: string
  readonly tools: ReadonlyArray<Tool.Info>
  readonly error?: string
}

export interface Interface {
  /** Wait for the initial documents to load and register. */
  readonly flush: Effect.Effect<void>
  readonly apis: () => Effect.Effect<ReadonlyArray<Api>>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/OpenApi") {}

/** Registry namespace segment for an API or operation path segment. */
export const namespace = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_")

type Operation = Extract<OpenAPI.Tools[string], { readonly _tag: "CodeModeTool" }>

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const registry = yield* Tool.Service
    const bus = yield* Bus.Service
    const http = yield* HttpClient.HttpClient
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const lock = Semaphore.makeUnsafe(1)
    let loaded: ReadonlyArray<Api> = []

    const read = (spec: string, directory: string) => {
      if (/^https?:\/\//i.test(spec))
        return http.execute(HttpClientRequest.get(spec).pipe(HttpClientRequest.acceptJson)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
          // A hung spec server would otherwise hold every Session's first request at flush.
          Effect.timeout("30 seconds"),
        )
      return fs.readFileString(
        spec.startsWith("~/") ? path.join(global.home, spec.slice(2)) : path.resolve(directory, spec),
      )
    }

    const operation = (api: string, segments: ReadonlyArray<string>, tool: Operation): Tool.Info => {
      const names = [api, ...segments].map(namespace)
      return {
        name: names[names.length - 1] ?? names.join("_"),
        options: { namespace: names.slice(0, -1).join(".") },
        description: tool.description,
        input: tool.input as JsonSchema.JsonSchema,
        // Responses without a declared schema still return their JSON or text body.
        output: (tool.output ?? {}) as JsonSchema.JsonSchema,
        execute: (input) =>
          tool.execute(input).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.mapError(
              (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
            ),
            Effect.map((output) => ({ output })),
          ),
      }
    }

    const loadApi = (api: string, entry: ConfigOpenAPI.Entry, directory: string) =>
      Effect.gen(function* () {
        const text = yield* read(entry.spec, directory)
        const document = yield* Effect.try({ try: () => parse(text), catch: (error) => error })
        const result = yield* Effect.try({
          try: () =>
            OpenAPI.fromSpec({
              spec: document,
              baseUrl: entry.base_url,
              headers: entry.headers,
              auth: { resolve: (context) => Effect.succeed(headerCredential(entry.headers ?? {}, context.definition)) },
            }),
          catch: (error) => error,
        })
        const tools = operations(result.tools, []).map(([segments, tool]) => operation(api, segments, tool))
        const skipped = result.skipped.map((item) => `${item.method} ${item.path}: ${item.reason}`)
        if (skipped.length > 0)
          yield* Effect.logWarning("skipped OpenAPI operations", { api, spec: entry.spec, skipped })
        const info = isRecord(document.info) ? document.info : {}
        return {
          namespace: api,
          ...(typeof info.title === "string" ? { title: info.title } : {}),
          ...(typeof info.description === "string" ? { description: info.description } : {}),
          tools,
          ...(tools.length === 0
            ? { error: `${entry.spec} has no supported operations${skipped.length > 0 ? ` (${skipped[0]})` : ""}` }
            : {}),
        } satisfies Api
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to load OpenAPI document", { api, spec: entry.spec, error }).pipe(
            Effect.as({
              namespace: api,
              tools: [],
              error: `failed to load ${entry.spec}: ${error instanceof Error ? error.message : String(error)}`,
            } satisfies Api),
          ),
        ),
      )

    const load = Effect.fn("OpenApi.load")(function* () {
      const configured = new Map<string, { readonly entry: ConfigOpenAPI.Entry; readonly directory: string }>()
      // A higher-precedence document replaces an API with the same namespace, including to disable it.
      for (const document of (yield* config.entries()).filter((entry): entry is Document => entry.type === "document"))
        for (const [name, entry] of Object.entries(document.info.openapi ?? {}))
          configured.set(namespace(name), {
            entry,
            directory: document.path ? path.dirname(document.path) : location.directory,
          })
      loaded = yield* Effect.forEach(
        [...configured].filter(([, item]) => item.entry.disabled !== true),
        ([api, item]) => loadApi(api, item.entry, item.directory),
        { concurrency: "unbounded" },
      )
    })

    const initial = yield* lock
      .withPermit(
        load().pipe(
          Effect.andThen(
            registry.transform((draft) => {
              for (const api of loaded) for (const tool of api.tools) draft.add(tool)
            }),
          ),
        ),
      )
      .pipe(Effect.forkScoped)
    yield* bus.subscribe(Event.Updated).pipe(
      // Each load rereads every document, so queued updates need only one refresh.
      Stream.runForEachArray(() => lock.withPermit(load().pipe(Effect.andThen(registry.reload())))),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({
      flush: Effect.asVoid(Fiber.await(initial)),
      apis: () => Effect.sync(() => loaded),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Tool.node, Bus.node, httpClient, FSUtil.node, Global.node, Location.node],
})

function parse(text: string): OpenAPI.Document {
  const json = decodeJson(text)
  // Bun parses YAML natively; other runtimes accept JSON documents only.
  const value = Option.isSome(json) ? json.value : typeof Bun === "undefined" ? undefined : Bun.YAML.parse(text)
  if (!isRecord(value))
    throw new Error(typeof Bun === "undefined" ? "not a JSON document" : "not a JSON or YAML document")
  if (typeof value.openapi === "string" && value.openapi.startsWith("3.")) return value
  throw new Error(
    typeof value.swagger === "string"
      ? `Swagger ${value.swagger} documents are not supported; convert it to OpenAPI 3`
      : "not an OpenAPI 3.x document",
  )
}

// Configured headers already travel on every request. Answering header-based security requirements from them
// keeps the adapter from refusing operations whose credentials the user supplied as plain headers.
function headerCredential(
  headers: Readonly<Record<string, string>>,
  scheme: OpenAPI.SecurityScheme,
): OpenAPI.Credential | undefined {
  const name = scheme.type !== "apiKey" ? "authorization" : scheme.in === "header" ? scheme.name : undefined
  if (name === undefined) return
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  if (value === undefined) return
  return { type: "header", name, value }
}

function operations(
  tools: OpenAPI.Tools,
  prefix: ReadonlyArray<string>,
): ReadonlyArray<readonly [ReadonlyArray<string>, Operation]> {
  return Object.entries(tools).flatMap(([key, value]) =>
    isOperation(value) ? [[[...prefix, key], value] as const] : operations(value, [...prefix, key]),
  )
}

function isOperation(value: OpenAPI.Tools[string]): value is Operation {
  return value._tag === "CodeModeTool"
}
