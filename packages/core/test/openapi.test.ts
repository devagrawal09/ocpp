import path from "path"
import { afterAll, describe, expect, setDefaultTimeout } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { Info } from "@ocpp/schema/config"
import { Bus } from "@ocpp/core/bus"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { Config } from "@ocpp/core/config"
import { ConfigNormalize } from "@ocpp/core/config/normalize"
import { Credential } from "@ocpp/core/credential"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Watcher } from "@ocpp/core/filesystem/watcher"
import { Job } from "@ocpp/core/job"
import { Location } from "@ocpp/core/location"
import { OpenApi } from "@ocpp/core/openapi/index"
import { OpenApiInstructions } from "@ocpp/core/openapi/instructions"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { Tool } from "@ocpp/core/tool"
import { WellKnown } from "@ocpp/core/wellknown"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Global } from "@ocpp/util/global"
import { emptyCredentialNode, emptyWellknownNode } from "./fixture/config-nodes"
import { withEnv } from "./fixture/env"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { readInitial } from "./lib/instructions"
import {
  codeModeTools,
  executeTool,
  readCodeModeNotebook,
  seedToolSession,
  toolDefinitions,
  toolIdentity,
  waitForCodeMode,
} from "./lib/tool"

// Each test boots real config discovery, a local HTTP server, and Code Mode storage.
setDefaultTimeout(15_000)

const fixture = path.join(import.meta.dir, "fixtures", "openapi-store.json")
const items = [
  { id: "1", name: "desk", stock: 4 },
  { id: "2", name: "chair", stock: 0 },
]
const yaml = `openapi: "3.0.3"
info:
  title: Status
paths:
  /status/{component}:
    get:
      parameters:
        - { name: component, in: path, required: true, schema: { type: string } }
      responses:
        "200": { description: Component status }
`
const received: Array<{ method: string; path: string; key: string | null; body?: unknown }> = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/openapi.json") return new Response(Bun.file(fixture))
    if (url.pathname === "/openapi.yaml") return new Response(yaml, { headers: { "content-type": "application/yaml" } })
    const body = request.method === "POST" ? await request.json() : undefined
    received.push({
      method: request.method,
      path: url.pathname + url.search,
      key: request.headers.get("x-api-key"),
      body,
    })
    if (request.headers.get("x-api-key") !== "secret-key")
      return Response.json({ message: "invalid API key" }, { status: 401 })
    if (request.method === "GET" && url.pathname === "/items")
      return Response.json(items.slice(0, Number(url.searchParams.get("limit") ?? items.length)))
    if (request.method === "POST" && url.pathname === "/items")
      return Response.json({ id: "3", ...(typeof body === "object" ? body : {}) }, { status: 201 })
    if (url.pathname === "/items/1") return Response.json(items[0])
    return Response.json({ message: `no item at ${url.pathname}` }, { status: 404 })
  },
})
afterAll(() => server.stop(true))
const baseURL = `http://127.0.0.1:${server.port}`

const jobLayer = AppNodeBuilder.build(LayerNode.group([Job.node]))
const runtimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const jobs = yield* Job.Service
    return Layer.mock(PluginRuntime.Service, {
      job: jobs,
      session: {
        get: () => Effect.die("Unavailable in OpenAPI tests"),
        create: () => Effect.die("Unavailable in OpenAPI tests"),
        messages: () => Effect.die("Unavailable in OpenAPI tests"),
        message: () => Effect.succeed(undefined),
        prompt: () => Effect.die("Unavailable in OpenAPI tests"),
        generate: () => Effect.die("Unavailable in OpenAPI tests"),
        command: () => Effect.die("Unavailable in OpenAPI tests"),
        rename: () => Effect.die("Unavailable in OpenAPI tests"),
        move: () => Effect.die("Unavailable in OpenAPI tests"),
        resume: () => Effect.die("Unavailable in OpenAPI tests"),
        switchAgent: () => Effect.die("Unavailable in OpenAPI tests"),
        selectTools: () => Effect.die("Unavailable in OpenAPI tests"),
        switchModel: () => Effect.die("Unavailable in OpenAPI tests"),
        interrupt: () => Effect.die("Unavailable in OpenAPI tests"),
        display: () => Effect.die("unused session.display"),
        synthetic: () => Effect.never,
        wait: () => Effect.die("Unavailable in OpenAPI tests"),
        context: () => Effect.die("Unavailable in OpenAPI tests"),
      },
      persistentPty: { read: () => Effect.die("Unavailable in OpenAPI tests") },
      location: {
        agent: { list: () => Effect.die("Unavailable in OpenAPI tests") },
        mcp: { list: () => Effect.die("Unavailable in OpenAPI tests") },
        tool: { paths: () => Effect.die("Unavailable in OpenAPI tests") },
      },
    })
  }),
).pipe(Layer.provide(jobLayer))

/** Writes `ocpp.json` and the fixture document into a fresh project and boots the API tools from it. */
const project = <A, E, R>(config: unknown, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    yield* Effect.promise(() =>
      Promise.all([
        Bun.write(path.join(tmp.path, "ocpp.json"), JSON.stringify(config)),
        Bun.write(path.join(tmp.path, "store.json"), Bun.file(fixture)),
      ]),
    )
    return yield* Effect.gen(function* () {
      const openapi = yield* OpenApi.Service
      yield* openapi.flush
      return yield* body
    }).pipe(
      Effect.provide(
        Layer.merge(
          AppNodeBuilder.build(
            LayerNode.group([
              Tool.node,
              OpenApi.node,
              OpenApiInstructions.node,
              Bus.node,
              Database.node,
              CodeModeStore.node,
            ]),
            [
              [Config.node, Config.configured({ global: false })],
              [
                Location.node,
                Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                ),
              ],
              [
                Global.node,
                Global.layerWith({ config: path.join(tmp.path, "global"), home: path.join(tmp.path, "home") }),
              ],
              [Credential.node, emptyCredentialNode],
              [WellKnown.node, emptyWellknownNode],
              [Watcher.node, Watcher.testLayer],
              [PluginRuntime.node, runtimeLayer],
            ],
          ),
          jobLayer,
        ),
      ),
    )
  })

const store = (entry: Record<string, unknown> = {}) => ({
  openapi: {
    store: {
      spec: "./store.json",
      base_url: baseURL,
      headers: { "X-Api-Key": "{env:OPENAPI_TEST_KEY}" },
      ...entry,
    },
  },
})

describe("OpenAPI", () => {
  it.live("lists every operation of a configured document in the Code Mode catalog", () =>
    project(
      store(),
      Effect.gen(function* () {
        const registry = yield* Tool.Service
        const snapshot = yield* registry.snapshot()

        expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["execute"])
        expect(yield* codeModeTools(registry)).toEqual([
          "notebook.inspect",
          "notebook.list",
          "store.getItem",
          "store.items.create",
          "store.listItems",
        ])
        expect(snapshot.codeModeCatalog?.find((tool) => tool.path === "store.listItems")).toMatchObject({
          description: "List items in stock",
          signature: expect.stringContaining("limit?: number"),
        })

        const instructions = yield* OpenApiInstructions.Service
        expect(
          (yield* instructions.load(yield* codeModeTools(registry), undefined).pipe(Effect.flatMap(readInitial))).text,
        ).toBe(
          [
            "<openapi_apis>",
            '  <api name="store" title="Demo Store">',
            '    Call this REST API\'s operations through `execute` under `tools["store"]`. Its configured headers and credentials are sent automatically. A non-2xx response throws an error that includes the HTTP status and response body.',
            "    Inventory for the demo store.",
            "  </api>",
            "</openapi_apis>",
          ].join("\n"),
        )
        // A tool list without the API hides it from that session's catalog and instructions.
        const without = { paths: ["other"] }
        expect(yield* codeModeTools(registry, without)).toEqual([])
        expect(
          (yield* instructions
            .load(yield* codeModeTools(registry, without), without.paths)
            .pipe(Effect.flatMap(readInitial))).text,
        ).toBe("")
      }),
    ),
  )

  it.live("calls operations from Code Mode with the configured secret header", () =>
    withEnv({ OPENAPI_TEST_KEY: "secret-key" }, () =>
      project(
        store(),
        Effect.gen(function* () {
          received.length = 0
          const registry = yield* Tool.Service
          const snapshot = yield* registry.snapshot()
          const sessionID = Session.ID.make("ses_openapi_codemode")
          yield* seedToolSession(sessionID, toolIdentity.messageID)
          const started = yield* snapshot.execute({
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_openapi",
              name: "execute",
              input: {
                code: [
                  "const firstItem = tools.store.listItems({ limit: 1 })",
                  'const created = tools.store.items.create({ body: { name: "lamp", stock: 3 } })',
                  'let message = ""',
                  'try { tools.store.getItem({ id: "missing" }) } catch (error) { message = error.message }',
                  "const missing = message",
                ].join("\n"),
              },
            },
          })

          expect(
            yield* waitForCodeMode(started.output, {
              sessionID,
              assistantMessageID: toolIdentity.messageID,
              id: "call_openapi",
            }),
          ).toMatchObject({ status: "saved", saved: ["firstItem", "created", "missing"] })
          expect(yield* readCodeModeNotebook(sessionID)).toMatchObject({
            firstItem: [{ id: "1", name: "desk", stock: 4 }],
            created: { id: "3", name: "lamp", stock: 3 },
            missing: 'GET /items/{id} failed with HTTP 404: {"message":"no item at /items/missing"}',
          })
          expect(received).toEqual([
            { method: "GET", path: "/items?limit=1", key: "secret-key", body: undefined },
            { method: "POST", path: "/items", key: "secret-key", body: { name: "lamp", stock: 3 } },
            { method: "GET", path: "/items/missing", key: "secret-key", body: undefined },
          ])
        }),
      ),
    ),
  )

  it.live("fails a call with the HTTP status and body of an error response", () =>
    withEnv({ OPENAPI_TEST_KEY: "wrong-key" }, () =>
      project(
        store(),
        Effect.gen(function* () {
          const registry = yield* Tool.Service
          expect(
            yield* executeTool(registry, {
              sessionID: Session.ID.make("ses_openapi_error"),
              ...toolIdentity,
              call: { type: "tool-call", id: "call_openapi_error", name: "store_getItem", input: { id: "1" } },
            }),
          ).toMatchObject({
            status: "error",
            error: { message: 'GET /items/{id} failed with HTTP 401: {"message":"invalid API key"}' },
          })
        }),
      ),
    ),
  )

  it.live("loads a document from a URL", () =>
    project(
      store({ spec: `${baseURL}/openapi.json` }),
      Effect.gen(function* () {
        expect(yield* codeModeTools(yield* Tool.Service)).toEqual([
          "notebook.inspect",
          "notebook.list",
          "store.getItem",
          "store.items.create",
          "store.listItems",
        ])
      }),
    ),
  )

  it.live("loads a YAML document and names operations without an operationId from their method and path", () =>
    project(
      store({ spec: `${baseURL}/openapi.yaml` }),
      Effect.gen(function* () {
        expect(yield* codeModeTools(yield* Tool.Service)).toEqual([
          "notebook.inspect",
          "notebook.list",
          "store.getStatusByComponent",
        ])
      }),
    ),
  )

  it.live("reports a document that cannot be loaded instead of registering tools", () =>
    project(
      {
        openapi: {
          missing: { spec: "./missing.json", base_url: baseURL },
          remote: { spec: `${baseURL}/absent.json`, base_url: baseURL },
          paused: { spec: "./store.json", base_url: baseURL, disabled: true },
        },
      },
      Effect.gen(function* () {
        expect(yield* codeModeTools(yield* Tool.Service)).toEqual([])
        const openapi = yield* OpenApi.Service
        const apis = yield* openapi.apis()
        expect(apis.map((api) => api.namespace)).toEqual(["missing", "remote"])
        expect(apis[0]?.error).toStartWith("failed to load ./missing.json: ")
        expect(apis[1]?.error).toStartWith(`failed to load ${baseURL}/absent.json: `)
        const instructions = yield* OpenApiInstructions.Service
        expect((yield* instructions.load([], undefined).pipe(Effect.flatMap(readInitial))).text).toContain(
          '  <api name="missing">\n    This REST API is configured, but its operations are unavailable: failed to load ./missing.json: ',
        )
      }),
    ),
  )
})

describe("OpenAPI config", () => {
  const decode = Schema.decodeUnknownOption(Info)

  it.effect("keeps valid entries and reports malformed ones", () =>
    Effect.sync(() => {
      const result = ConfigNormalize.normalize({
        openapi: {
          github: {
            spec: "https://example.com/openapi.json",
            base_url: "https://api.example.com",
            headers: { Authorization: "Bearer token" },
            disabled: false,
          },
          broken: { base_url: "https://api.example.com" },
          wrong: { spec: "./spec.json", headers: { "X-Count": 1 } },
        },
      })
      if (result.type !== "normalized") throw new Error("configuration was rejected")
      expect(result.encoded.openapi).toEqual({
        github: {
          spec: "https://example.com/openapi.json",
          base_url: "https://api.example.com",
          headers: { Authorization: "Bearer token" },
          disabled: false,
        },
      })
      expect(result.diagnostics).toEqual([
        { kind: "invalid", path: ["openapi", "broken"], message: "skipped malformed recognized value" },
        { kind: "invalid", path: ["openapi", "wrong"], message: "skipped malformed recognized value" },
      ])
      expect(Option.getOrThrow(decode(result.encoded)).openapi?.github?.spec).toBe("https://example.com/openapi.json")
    }),
  )

  it.effect("rejects a non-object openapi section", () =>
    Effect.sync(() => {
      const result = ConfigNormalize.normalize({ openapi: "https://example.com/openapi.json" })
      if (result.type !== "normalized") throw new Error("configuration was rejected")
      expect(result.encoded.openapi).toBeUndefined()
      expect(result.diagnostics).toEqual([
        { kind: "invalid", path: ["openapi"], message: "skipped malformed recognized value" },
      ])
    }),
  )
})
