import { Agent } from "@opencode-ai/core/agent"
import { AISDK } from "@opencode-ai/core/aisdk"
import { Catalog } from "@opencode-ai/core/catalog"
import { Command } from "@opencode-ai/core/command"
import { Config } from "@opencode-ai/core/config"
import { Credential } from "@opencode-ai/core/credential"
import { LayerNodePlatform } from "@opencode-ai/util/effect/app-node-platform"
import { AppProcess } from "@opencode-ai/util/process"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Bus } from "@opencode-ai/core/bus"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Form } from "@opencode-ai/core/form"
import { Generate } from "@opencode-ai/core/generate"
import { Integration } from "@opencode-ai/core/integration"
import { Job } from "@opencode-ai/core/job"
import { KV } from "@opencode-ai/core/kv"
import { Location } from "@opencode-ai/core/location"
import { Mcp } from "@opencode-ai/core/mcp/index"
import { Npm } from "@opencode-ai/util/npm"
import { Plugin } from "@opencode-ai/core/plugin"
import { PluginHooks } from "@opencode-ai/core/plugin/hooks"
import { PluginRuntime } from "@opencode-ai/core/plugin/runtime"
import { Permission } from "@opencode-ai/core/permission"
import { Reference } from "@opencode-ai/core/reference"
import { Skill } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Tool } from "@opencode-ai/core/tool"
import { Vcs } from "@opencode-ai/core/vcs"
import { WebSearch } from "@opencode-ai/core/websearch"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"
import { emptyMcpLayer } from "../fixture/mcp"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    resolve: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    which: () => Effect.undefined,
  }),
)

const generateLayer = Layer.succeed(Generate.Service, Generate.Service.of({ text: () => Effect.succeed("") }))

const permissionLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

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
      Form.node,
      Generate.node,
      LayerNodePlatform.httpClient,
      Plugin.node,
      Agent.node,
      AISDK.node,
      Catalog.node,
      Command.node,
      Integration.node,
      KV.node,
      Mcp.node,
      PluginRuntime.node,
      Permission.node,
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
      [Permission.node, permissionLayer],
      [PluginRuntime.node, runtimeLayer],
    ],
  ),
  jobLayer,
) as unknown as Layer.Layer<unknown, never>
