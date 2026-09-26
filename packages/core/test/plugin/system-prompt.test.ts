import { describe, expect, test } from "bun:test"
import { SystemPart } from "@ocpp/ai"
import { Agent } from "@ocpp/core/agent"
import { Catalog } from "@ocpp/core/catalog"
import { Plugin } from "@ocpp/core/plugin"
import { PluginHooks } from "@ocpp/core/plugin/hooks"
import { PluginHost } from "@ocpp/core/plugin/host"
import { SystemPromptPlugin } from "@ocpp/core/plugin/system-prompt"
import { Session } from "@ocpp/core/session"
import { SessionSystemPrompt } from "@ocpp/core/session/system-prompt"
import type { SessionHooks } from "@ocpp/plugin/effect/session"
import { Model } from "@ocpp/schema/model"
import { Provider } from "@ocpp/schema/provider"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"
import PROMPT_ANTHROPIC from "../../src/plugin/system-prompt/anthropic.txt"
import PROMPT_CODEX from "../../src/plugin/system-prompt/codex.txt"
import PROMPT_GPT from "../../src/plugin/system-prompt/gpt.txt"
import PROMPT_KIMI from "../../src/plugin/system-prompt/kimi.txt"
import PROMPT_META from "../../src/plugin/system-prompt/meta.txt"
import PROMPT_TRINITY from "../../src/plugin/system-prompt/trinity.txt"

const it = testEffect(PluginTestLayer)
const fallback = SessionSystemPrompt.make([])
const makeHost = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const plugins = yield* Plugin.Service
  yield* agents.transform((draft) => draft.update(Agent.ID.make("build"), () => {}))
  return yield* PluginHost.make(plugins)
})

const context = (id: string, system = fallback): SessionHooks["context"] => ({
  sessionID: Session.ID.make("ses_system_prompt"),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make(id) }),
  system: [SystemPart.make(system)],
  messages: [],
  tools: {},
  generation: {},
  providerOptions: {},
})

describe("SystemPromptPlugin", () => {
  test("uses current vocabulary in the Meta prompt", () => {
    expect(PROMPT_META).toContain("Your only tool is `execute`.")
    expect(PROMPT_META).toContain("`tools.webfetch`")
    expect(PROMPT_META).toContain("`tools.subagent`")
    expect(PROMPT_META).toContain("Reserve `tools.shell`")
    expect(PROMPT_META).toContain("`tools.read` instead of `cat`")
    expect(PROMPT_META).toContain("`tools.edit` instead of `sed`")
    expect(PROMPT_META).toContain("`tools.write` instead of `cat`")
    expect(PROMPT_META).toContain("Follow that reminder for the files you may edit")
    expect(PROMPT_META).toContain("https://ocpp.ai/v2/docs/")
    expect(PROMPT_META).not.toMatch(
      /TodoWrite|Task tool|WebFetch|\bBash\b|including planning files|https:\/\/ocpp\.ai\/docs|the `\w+` tool/,
    )
  })

  // Each family prompt replaces the default system prompt, so each must state the Code Mode rules itself.
  test("states that execute is the only tool in every model-lab prompt", () => {
    const prompts = {
      anthropic: PROMPT_ANTHROPIC,
      codex: PROMPT_CODEX,
      gpt: PROMPT_GPT,
      kimi: PROMPT_KIMI,
      meta: PROMPT_META,
      trinity: PROMPT_TRINITY,
    }
    for (const [name, prompt] of Object.entries(prompts)) {
      expect({ name, states: prompt.includes("Your only tool is `execute`.") }).toEqual({ name, states: true })
      expect({
        name,
        direct: prompt.match(
          /the `?(?:read|write|edit|patch|glob|grep|shell|subagent|question|skill|webfetch|websearch)`? tool\b|\b(?:use|uses) (?:read|grep|glob|edit|write|patch)\b/gi,
        ),
      }).toEqual({ name, direct: null })
    }
  })

  test("uses granular IDs with a common prefix", () => {
    expect(SystemPromptPlugin.Plugins.map((plugin) => plugin.id)).toEqual([
      "ocpp.prompt.openai",
      "ocpp.prompt.anthropic",
      "ocpp.prompt.kimi",
      "ocpp.prompt.arcee",
      "ocpp.prompt.meta",
    ])
  })

  it.effect("selects model-lab prompts through session context hooks", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const pluginHost = yield* makeHost
      yield* Effect.forEach(SystemPromptPlugin.Plugins, (plugin) => plugin.effect(pluginHost), {
        discard: true,
      })
      const cases = [
        ["gpt-5", "You are OC++, You and the user share the same workspace"],
        ["gpt-4.1", "You are OC++, You and the user share the same workspace"],
        ["o3", "You are OC++, You and the user share the same workspace"],
        ["gpt-5-codex", "## Editing constraints"],
        ["gemini-2.5-pro", fallback],
        ["claude-sonnet-4", "# Professional objectivity"],
        ["kimi-k2", "# Prompt and Tool Use"],
        ["trinity", "what command should I run to list files"],
        ["meta/muse-spark-1.1", "powered by Muse Spark"],
        ["llama-3.3", fallback],
      ] as const

      yield* Effect.forEach(
        cases,
        ([id, expected]) => {
          const event = context(id)
          return hooks
            .trigger("session", "context", event)
            .pipe(Effect.tap(() => Effect.sync(() => expect(event.system[0]?.text).toContain(expected))))
        },
        { discard: true },
      )
    }),
  )

  it.effect("selects the Meta prompt for Muse family model IDs", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const pluginHost = yield* makeHost
      yield* SystemPromptPlugin.MetaPlugin.effect(pluginHost)

      yield* Effect.forEach(
        [
          ["meta/muse-spark-preview", "Muse Spark"],
          ["muse-spark-1.2", "Muse Spark"],
          ["meta/muse-glimmer-30b", "Muse Glimmer"],
          ["muse-glimmer-30b", "Muse Glimmer"],
        ] as const,
        ([id, name]) => {
          const event = context(id)
          return hooks.trigger("session", "context", event).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                expect(event.system[0]?.text).toContain(`powered by ${name},`)
                expect(event.system[0]?.text).toContain(`using Meta ${name}.`)
                expect(event.system[0]?.text).not.toContain("{{MODEL_NAME}}")
              }),
            ),
          )
        },
        { discard: true },
      )
    }),
  )

  it.effect("preserves an explicit agent system prompt", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const hooks = yield* PluginHooks.Service
      yield* agents.transform((draft) =>
        draft.update(Agent.ID.make("build"), (agent) => {
          agent.system = "Custom agent prompt"
        }),
      )
      const pluginHost = yield* makeHost
      yield* Effect.forEach(SystemPromptPlugin.Plugins, (plugin) => plugin.effect(pluginHost), {
        discard: true,
      })
      const event = context("gpt-5", "Custom agent prompt")

      yield* hooks.trigger("session", "context", event)

      expect(event.system.map((part) => part.text)).toEqual(["Custom agent prompt"])
    }),
  )

  it.effect("skips the hook when agent lookup fails", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const hooks = yield* PluginHooks.Service
      const pluginHost = yield* makeHost
      yield* SystemPromptPlugin.OpenAIPlugin.effect(pluginHost)
      yield* agents.transform((draft) => draft.remove(Agent.ID.make("build")))
      const event = context("gpt-5")

      yield* hooks.trigger("session", "context", event)

      expect(event.system[0]?.text).toBe(fallback)
    }),
  )

  it.effect("allows one model-lab prompt plugin to be enabled independently", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const pluginHost = yield* makeHost
      yield* SystemPromptPlugin.AnthropicPlugin.effect(pluginHost)
      const gemini = context("gemini-2.5-pro")
      const claude = context("claude-sonnet-4")

      yield* hooks.trigger("session", "context", gemini)
      yield* hooks.trigger("session", "context", claude)

      expect(gemini.system[0]?.text).toBe(fallback)
      expect(claude.system[0]?.text).toContain("# Professional objectivity")
    }),
  )

  it.effect("selects against the catalog model ID instead of its alias", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const hooks = yield* PluginHooks.Service
      const pluginHost = yield* makeHost
      yield* catalog.transform((draft) => {
        draft.model.update(Provider.ID.make("test"), Model.ID.make("openai-alias"), (model) => {
          model.modelID = Model.ID.make("gpt-5")
        })
        draft.model.update(Provider.ID.make("test"), Model.ID.make("gpt-5-alias"), (model) => {
          model.modelID = Model.ID.make("custom-model")
        })
        draft.model.update(Provider.ID.make("test"), Model.ID.make("codex-family-alias"), (model) => {
          model.modelID = Model.ID.make("custom-deployment")
          model.family = Model.Family.make("gpt-codex")
        })
      })
      yield* SystemPromptPlugin.OpenAIPlugin.effect(pluginHost)
      const physicalOpenAI = context("openai-alias")
      const physicalCustom = context("gpt-5-alias")
      const familyOpenAI = context("codex-family-alias")

      yield* hooks.trigger("session", "context", physicalOpenAI)
      yield* hooks.trigger("session", "context", physicalCustom)
      yield* hooks.trigger("session", "context", familyOpenAI)

      expect(physicalOpenAI.system[0]?.text).toContain("You are OC++, You and the user share the same workspace")
      expect(physicalCustom.system[0]?.text).toBe(fallback)
      expect(familyOpenAI.system[0]?.text).toContain("## Editing constraints")
    }),
  )
})
