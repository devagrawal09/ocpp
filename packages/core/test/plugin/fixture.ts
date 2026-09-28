import { Agent } from "@ocpp/core/agent"
import { AISDK } from "@ocpp/core/aisdk"
import { Catalog } from "@ocpp/core/catalog"
import { Command } from "@ocpp/core/command"
import { Config } from "@ocpp/core/config"
import { Credential } from "@ocpp/core/credential"
import { LayerNodePlatform } from "@ocpp/util/effect/app-node-platform"
import { AppProcess } from "@ocpp/util/process"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Bus } from "@ocpp/core/bus"
import { Database } from "@ocpp/core/database/database"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { FileSystem } from "@ocpp/core/filesystem"
import { FSUtil } from "@ocpp/util/fs-util"
import { Form } from "@ocpp/core/form"
import { Generate } from "@ocpp/core/generate"
import { Integration } from "@ocpp/core/integration"
import { Job } from "@ocpp/core/job"
import { KV } from "@ocpp/core/kv"
import { Location } from "@ocpp/core/location"
import { Mcp } from "@ocpp/core/mcp/index"
import { Npm } from "@ocpp/util/npm"
import { Plugin } from "@ocpp/core/plugin"
import { PluginHooks } from "@ocpp/core/plugin/hooks"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { Reference } from "@ocpp/core/reference"
import { Skill } from "@ocpp/core/skill"
import { SkillDiscovery } from "@ocpp/core/skill/discovery"
import { Watcher } from "@ocpp/core/filesystem/watcher"
import { Tool } from "@ocpp/core/tool"
import { Vcs } from "@ocpp/core/vcs"
import { WebSearch } from "@ocpp/core/websearch"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"
import { emptyMcpLayer } from "../fixture/mcp"
import { noVendorDrivers } from "../lib/drivers"
import { ExternalAgentDrivers } from "@ocpp/core/external-agent/drivers"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    which: () => Effect.undefined,
  }),
)

const generateLayer = Layer.succeed(Generate.Service, Generate.Service.of({ text: () => Effect.succeed("") }))

const jobLayer = LayerNode.compile(LayerNode.group([Job.node]))
const runtimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const jobs = yield* Job.Service
    return Layer.mock(PluginRuntime.Service, {
      job: jobs,
      session: {
        get: () => Effect.die("Unavailable in Plugin tests"),
        create: () => Effect.die("Unavailable in Plugin tests"),
        messages: () => Effect.die("Unavailable in Plugin tests"),
        message: () => Effect.succeed(undefined),
        prompt: () => Effect.die("Unavailable in Plugin tests"),
        generate: () => Effect.die("Unavailable in Plugin tests"),
        command: () => Effect.die("Unavailable in Plugin tests"),
        rename: () => Effect.die("Unavailable in Plugin tests"),
        move: () => Effect.die("Unavailable in Plugin tests"),
        resume: () => Effect.die("Unavailable in Plugin tests"),
        switchAgent: () => Effect.die("Unavailable in Plugin tests"),
        selectTools: () => Effect.die("Unavailable in Plugin tests"),
        switchModel: () => Effect.die("Unavailable in Plugin tests"),
        interrupt: () => Effect.die("Unavailable in Plugin tests"),
        synthetic: () => Effect.never,
        wait: () => Effect.die("Unavailable in Plugin tests"),
        context: () => Effect.die("Unavailable in Plugin tests"),
      },
      persistentPty: { read: () => Effect.die("Unavailable in Plugin tests") },
      location: {
        agent: { list: () => Effect.die("Unavailable in Plugin tests") },
        mcp: { list: () => Effect.die("Unavailable in Plugin tests") },
        tool: { paths: () => Effect.die("Unavailable in Plugin tests") },
      },
    })
  }),
).pipe(Layer.provide(jobLayer))

export const PluginTestLayer = Layer.merge(
  LayerNode.compile(
    LayerNode.group([
      AppProcess.node,
      FileSystem.node,
      FSUtil.node,
      Location.node,
      Npm.node,
      Credential.node,
      Bus.node,
      Database.node,
      CodeModeStore.node,
      Form.node,
      Generate.node,
      LayerNodePlatform.httpClient,
      Plugin.node,
      Agent.node,
      AISDK.node,
      Catalog.node,
      Command.node,
      ExternalAgentDrivers.node,
      Integration.node,
      KV.node,
      Mcp.node,
      PluginRuntime.node,
      PluginHooks.node,
      Reference.node,
      Skill.node,
      SkillDiscovery.node,
      Tool.node,
      Vcs.node,
      Watcher.node,
      WebSearch.node,
    ]),
    [
      [Location.node, tempLocationLayer],
      [Npm.node, npmLayer],
      [Config.node, Config.testLayer()],
      [Mcp.node, emptyMcpLayer],
      [Generate.node, generateLayer],
      [PluginRuntime.node, runtimeLayer],
      [ExternalAgentDrivers.node, noVendorDrivers],
    ],
  ),
  jobLayer,
) as unknown as Layer.Layer<unknown, never>
