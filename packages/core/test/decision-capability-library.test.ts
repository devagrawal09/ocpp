import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { CodeMode } from "@ocpp/codemode"
import { Patch } from "@ocpp/util/patch"
import { Agent } from "@ocpp/schema/agent"
import { Session } from "@ocpp/schema/session"
import { SessionMessage } from "@ocpp/schema/session-message"
import { Tool } from "@ocpp/schema/tool"
import { Effect, Schema } from "effect"
import { CodeModeEvaluator } from "../src/codemode/evaluator"
import { CodeModeTool } from "../src/codemode/tool"
import { effectiveName, execute } from "../src/tool/runtime"
import { Environment } from "../src/environment/index"
import { AbsolutePath } from "../src/schema"
import { ReadToolFileSystem } from "../src/tool/read-filesystem"
import { ChildProcessSpawner } from "effect/process"
import { CrossSpawnSpawner } from "@ocpp/util/cross-spawn-spawner"
import { LayerNodePlatform } from "@ocpp/util/effect/app-node-platform"
import { LayerNode } from "@ocpp/util/effect/layer-node"

const scripts = await Promise.all(
  ["notebook", "library", "jev"].map(
    async (name) =>
      (
        await Bun.file(new URL("../../../.ocpp/experiments/decision-loop/" + name + ".js", import.meta.url)).text()
      ).split("\ntools.command.define(")[0],
  ),
)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const repair =
  'const manifest = { id: "repair-double", description: "Repair an off-by-one implementation of double in value.ts", dependencies: [], supersedes: [] };' +
  "function createCapability(environment, library) { return { id: manifest.id, state: { workspace: environment.workspace }," +
  'questions: { useful: { type: "noul", instructions: "The double implementation needs repair." } },' +
  "execute: (answers, context) => { if (answers.useful.noul < 0.5) return {};" +
  'const observed = tools.shell({ command: "head -30 value.ts", workdir: environment.workspace });' +
  'if (!observed.output.includes("return n + 1")) return {};' +
  "tools.patch({ patchText: " +
  JSON.stringify("*** Begin Patch\n*** Update File: ") +
  " + environment.workspace + " +
  JSON.stringify("/value.ts\n@@\n-  return n + 1\n+  return n * 2\n*** End Patch") +
  " });" +
  'return { state: { repaired: true, checked: tools.shell({ command: "bun test", workdir: environment.workspace }) } }; } }; }'

const composed =
  'const manifest = { id: "composed-repair", description: "Compose the reusable double repair", dependencies: ["repair-double@1"], supersedes: [] };' +
  'function createCapability(environment, library) { const dependency = library["repair-double@1"];' +
  "return { id: manifest.id, state: { composed: true }, questions: dependency.questions," +
  "execute: (answers, context) => ({ state: { composed: dependency.execute(answers, context) } }) }; }"

const generalized =
  'const manifest = { id: "repair-double", description: "A generalized replacement", dependencies: [], supersedes: ["repair-double@1"] };' +
  "function createCapability(environment, library) { return { id: manifest.id, state: {}," +
  'questions: { useful: { type: "noul", instructions: "Use generalized behavior." } },' +
  "execute: (answers, context) => ({ state: { generalized: true } }) }; }"

async function setup(sources = [repair]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocpp", "capability-library-"))
  roots.push(root)
  const library = path.join(root, "library.json")
  const generations: Array<Schema.Json> = []
  const batches: Array<Schema.Json> = []
  const reads = {
    name: "read",
    description: "Read real fixture files",
    input: Schema.Struct({
      path: Schema.String,
      limit: Schema.optionalKey(Schema.Number),
      offset: Schema.optionalKey(Schema.Number),
    }),
    output: Schema.Json,
    execute: (input) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const output = yield* ReadToolFileSystem.read(
          Environment.makeFiles(Environment.makeLocalDriver(spawner)),
          AbsolutePath.make(input.path),
          input.path,
          { offset: input.offset, limit: input.limit },
        )
        return { output: { ...output } }
      }).pipe(
        Effect.provide(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem]))),
        Effect.mapError((error) => new Tool.Error({ message: String(error) })),
      ),
  } satisfies Tool.Info
  const glob = {
    name: "glob",
    description: "Find real fixture files",
    input: Schema.Struct({ path: Schema.String, pattern: Schema.String, limit: Schema.Number }),
    output: Schema.Json,
    execute: (input) =>
      Effect.promise(async () => ({
        output: (
          await Array.fromAsync(new Bun.Glob(input.pattern).scan({ cwd: input.path, absolute: true, onlyFiles: true }))
        )
          .slice(0, input.limit)
          .map((file) => ({ path: file, type: "file" })),
      })),
  } satisfies Tool.Info
  const patch = {
    name: "patch",
    description: "Apply real patches",
    input: Schema.Struct({ patchText: Schema.String }),
    output: Schema.Json,
    execute: (input) =>
      Effect.gen(function* () {
        const hunks = yield* Effect.fromResult(Patch.parse(input.patchText)).pipe(
          Effect.mapError((error) => new Tool.Error({ message: error.message })),
        )
        yield* Effect.forEach(hunks, (hunk) =>
          Effect.promise(async () => {
            if (hunk.type === "delete") return rm(hunk.path)
            await Bun.write(
              hunk.path,
              hunk.type === "add"
                ? hunk.contents
                : Patch.derive(hunk.path, hunk.chunks, await Bun.file(hunk.path).text()).content,
            )
          }),
        )
        return { output: { applied: hunks.map((hunk) => ({ type: hunk.type, resource: hunk.path })) } }
      }),
  } satisfies Tool.Info
  const shell = {
    name: "shell",
    description: "Run real observation/check commands",
    input: Schema.Struct({
      command: Schema.String,
      workdir: Schema.String,
      timeout: Schema.optionalKey(Schema.Number),
    }),
    output: Schema.Json,
    execute: (input) =>
      Effect.sync(() => {
        const result = Bun.spawnSync(["/bin/sh", "-c", input.command], { cwd: input.workdir })
        return { output: { exit: result.exitCode, output: result.stdout.toString() + result.stderr.toString() } }
      }),
  } satisfies Tool.Info
  // Script only model outputs. Source execution, evaluator isolation, persistence, patches, and checks are real.
  const generate = {
    name: "code",
    options: { namespace: "generate" },
    description: "Deterministic generation fixture",
    input: Schema.Json,
    output: Schema.Json,
    execute: (input) =>
      Effect.sync(() => {
        const source = sources[generations.length]
        if (!source) throw new Error("Unexpected generation")
        generations.push(input)
        return { output: { code: source, language: "JavaScript" } }
      }),
  } satisfies Tool.Info
  const decision = {
    name: "ask",
    options: { namespace: "decision" },
    description: "Deterministic judgment fixture",
    input: Schema.Struct({
      state: Schema.Struct({
        context: Schema.Array(Schema.Json),
        capabilities: Schema.Array(Schema.Struct({ id: Schema.String, state: Schema.optionalKey(Schema.Json) })),
      }),
      questions: Schema.Record(Schema.String, Schema.Json),
    }),
    output: Schema.Json,
    execute: (input) =>
      Effect.sync(() => {
        batches.push(input)
        const done = JSON.stringify(input.state.context).includes('"repaired":true')
        return {
          output: {
            answers: Object.fromEntries(
              Object.keys(input.questions).map((key) => {
                const id = input.state.capabilities[Number(key.split(".")[0])]!.id
                const value =
                  id === "quit"
                    ? Number(done)
                    : id === "factory"
                      ? Number(!done && generations.length < sources.length)
                      : id.startsWith("library:")
                        ? Number(!done)
                        : 0
                return [key, { noul: value }]
              }),
            ),
          },
        }
      }),
  } satisfies Tool.Info
  const evaluator = CodeModeEvaluator.tool((_name, tool, input, context) => execute(tool, input, context))
  const display = {
    name: "display_result",
    description: "Capture progress output",
    input: Schema.Json,
    output: Schema.Json,
    execute: () => Effect.succeed({ output: { id: "display" } }),
  } satisfies Tool.Info
  const registrations = new Map(
    [reads, glob, patch, shell, generate, decision, evaluator, display].map((tool) => [effectiveName(tool), tool]),
  )
  const context: Tool.Context = {
    sessionID: Session.ID.make("ses_library"),
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_library"),
    id: Tool.CallID.make("call_library"),
    progress: () => Effect.void,
    catalog: new Map(
      Array.from(registrations.values(), (tool) => [CodeModeTool.qualifiedName(tool), { tool, lent: false }]),
    ),
  }
  const tools = CodeModeTool.tools(registrations, (_name, tool, input) =>
    execute(tool, input, context).pipe(Effect.map((result) => result.output)),
  )
  const run = async (code: string, input: CodeMode.DataValue = {}) => {
    const result = await Effect.runPromise(
      Effect.scoped(
        CodeMode.execute({
          code: "{\n" + scripts.join("\n") + "\n" + code + "\n}",
          input,
          tools,
          limits: { timeoutMs: 30_000, maxOutputBytes: 1_000_000 },
        }),
      ),
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result))
    return result.value
  }
  const workspace = async (name: string, value: number) => {
    const directory = path.join(root, name)
    await Bun.write(path.join(directory, "value.ts"), "export function double(n: number) {\n  return n + 1\n}\n")
    await Bun.write(
      path.join(directory, "value.test.ts"),
      'import { expect, test } from "bun:test"\ntest("double", () => expect(require("./value").double(' +
        value +
        ")).toBe(" +
        value * 2 +
        "))\n",
    )
    return directory
  }
  return { root, library, run, workspace, generations, batches }
}

test("automatically persists generation, reloads in a separate execution, and reuses in a different workspace", async () => {
  const fixture = await setup()
  const first = await fixture.workspace("first", 3)
  const second = await fixture.workspace("second", 7)
  const originalTests = await Bun.file(path.join(second, "value.test.ts")).text()
  expect(
    await fixture.run("return capabilityLibraryRun(input)", { workspace: first, library: fixture.library }),
  ).toMatchObject({ reason: "quit" })
  expect(fixture.generations).toHaveLength(1)
  expect(
    await fixture.run("return capabilityLibraryRun(input)", { workspace: second, library: fixture.library }),
  ).toMatchObject({ reason: "quit" })
  expect(fixture.generations).toHaveLength(1)
  const stored = JSON.parse((await Bun.file(fixture.library).json()).chunks.join(""))
  expect(stored.entries).toHaveLength(1)
  expect(stored.entries[0].source).toBe(repair)
  expect(stored.entries[0].evidence.map((item: { workspace: string }) => item.workspace)).toContain(second)
  expect(Bun.spawnSync(["bun", "test"], { cwd: second }).exitCode).toBe(0)
  expect(await Bun.file(path.join(second, "value.test.ts")).text()).toBe(originalTests)
})

test("composes pinned dependencies and keeps the old revision after generalization", async () => {
  const fixture = await setup()
  const workspace = await fixture.workspace("composed", 9)
  expect(
    await fixture.run(
      "const library = capabilityLibrary(input.library); return [library.admit(input.repair, input.environment), library.admit(input.composed, input.environment), library.admit(input.generalized, input.environment)]",
      { library: fixture.library, repair, composed, generalized, environment: { workspace, files: [] } },
    ),
  ).toMatchObject([{ ok: true }, { ok: true }, { ok: true }])
  expect(
    await fixture.run(
      'const library = capabilityLibrary(input.library); const described = capabilityLibraryDescribe(library.snapshot(), "composed-repair@1", input.environment); return { active: library.active().map((entry) => entry.ref), outcome: capabilityLibraryGenerated(library, "composed-repair@1", input.environment, described.value).execute({ useful: { noul: 1 } }, [{ goal: "repair" }]).state }',
      { library: fixture.library, environment: { workspace, files: [] } },
    ),
  ).toMatchObject({
    active: ["composed-repair@1", "repair-double@2"],
    outcome: { composed: { state: { repaired: true } } },
  })
  const stored = JSON.parse((await Bun.file(fixture.library).json()).chunks.join(""))
  expect(stored.entries[1].dependencies).toEqual(["repair-double@1"])
  expect(stored.entries[0].source).toBe(repair)
  expect(Bun.spawnSync(["bun", "test"], { cwd: workspace }).exitCode).toBe(0)
})

test("generation sees existing source and evidence, and waits for the previous acquisition's execution", async () => {
  const fixture = await setup([repair, composed])
  const workspace = await fixture.workspace("generation", 5)
  expect(
    await fixture.run(
      'const library = capabilityLibrary(input.library); const factory = capabilityLibraryFactory(library, input.environment, {}); const first = factory.execute({ useful: { noul: 1 } }, [{ goal: "repair" }]); const premature = factory.execute({ useful: { noul: 1 } }, [{ goal: "repair" }]); const performed = first.capabilities[0].execute({ useful: { noul: 1 } }, [{ goal: "repair" }]); const second = factory.execute({ useful: { noul: 1 } }, [{ goal: "repair" }, { capability: first.capabilities[0].id, state: performed.state }]); return { premature, admitted: second.state.admitted }',
      { library: fixture.library, environment: { workspace, files: [] } },
    ),
  ).toEqual({ premature: {}, admitted: "composed-repair@1" })
  expect(fixture.generations).toHaveLength(2)
  expect(fixture.generations[1]).toMatchObject({
    context: { library: [{ ref: "repair-double@1", source: repair, evidence: [{ workspace }] }] },
  })
})

test("rejects unknown dependencies, malformed contracts, and construction effects without changing the library", async () => {
  const fixture = await setup()
  const workspace = await fixture.workspace("invalid", 4)
  const result = await fixture.run(
    "const library = capabilityLibrary(input.library); return input.sources.map((source) => library.admit(source, input.environment))",
    {
      library: fixture.library,
      environment: { workspace, files: [] },
      sources: [
        composed,
        repair.replace('instructions: "The double implementation needs repair."', "instructions: 12"),
        repair.replace(
          "return { id: manifest.id",
          'tools.shell({ command: "touch constructed", workdir: environment.workspace }); return { id: manifest.id',
        ),
        repair.replace("execute: (answers, context)", "notExecute: (answers, context)"),
        repair.replace('type: "noul"', 'type: "choice"'),
      ],
    },
  )
  expect(result).toMatchObject([{ ok: false }, { ok: false }, { ok: false }, { ok: false }, { ok: false }])
  expect(await Bun.file(fixture.library).exists()).toBe(false)
  expect(await Bun.file(path.join(workspace, "constructed")).exists()).toBe(false)
})

test("records execution diagnostics and retires failures locally without deleting reusable source", async () => {
  const fixture = await setup()
  const source = generalized
    .replace('["repair-double@1"]', "[]")
    .replace("({ state: { generalized: true } })", 'tools.shell({ command: "pwd", workdir: null })')
  const workspace = await fixture.workspace("failure", 2)
  expect(
    await fixture.run(
      'const library = capabilityLibrary(input.library); const admitted = library.admit(input.source, input.environment); const outcome = capabilityLibraryGenerated(library, admitted.entry.ref, input.environment, admitted.description).execute({ useful: { noul: 1 } }, [{ goal: "repair" }]); return { offers: outcome.capabilities.length, evidence: library.snapshot()[0].evidence, active: library.active().length }',
      { library: fixture.library, source, environment: { workspace, files: [] } },
    ),
  ).toMatchObject({ offers: 0, evidence: [{ result: { ok: false } }], active: 1 })
})

test("refuses corrupt or unsupported persisted libraries rather than silently replacing them", async () => {
  const fixture = await setup()
  const invalid = JSON.stringify({ version: 2, entries: [] })
  await Bun.write(fixture.library, invalid)
  expect(
    await fixture.run("try { capabilityLibrary(input.library); return false } catch (error) { return String(error) }", {
      library: fixture.library,
    }),
  ).toContain("Unsupported")
  expect(await Bun.file(fixture.library).text()).toBe(invalid)
})

test("preserves returned observations so a reused capability can recognize its own prior work", async () => {
  const fixture = await setup()
  const source = generalized
    .replace('["repair-double@1"]', "[]")
    .replace(
      "({ state: { generalized: true } })",
      "context.some((observation) => observation.state?.generalized) ? {} : ({ state: { generalized: true } })",
    )
  const workspace = await fixture.workspace("observations", 2)
  expect(
    await fixture.run(
      'const library = capabilityLibrary(input.library); const admitted = library.admit(input.source, input.environment); const adapter = capabilityLibraryGenerated(library, admitted.entry.ref, input.environment, admitted.description); const first = adapter.execute({ useful: { noul: 1 } }, [{ goal: "inspect" }]); const second = adapter.execute({ useful: { noul: 1 } }, [{ goal: "inspect" }, { capability: adapter.id, state: first.state }]); return { first: first.state, second: second.state.library.result.value }',
      { library: fixture.library, source, environment: { workspace, files: [] } },
    ),
  ).toEqual({ first: { generalized: true }, second: {} })
})

test("rejects malformed execution outcomes before they can corrupt the loop context", async () => {
  const fixture = await setup()
  const source = generalized
    .replace('["repair-double@1"]', "[]")
    .replace("({ state: { generalized: true } })", "({ replaceContext: {} })")
  const workspace = await fixture.workspace("outcome", 2)
  expect(
    await fixture.run(
      'const library = capabilityLibrary(input.library); const admitted = library.admit(input.source, input.environment); const outcome = capabilityLibraryGenerated(library, admitted.entry.ref, input.environment, admitted.description).execute({ useful: { noul: 1 } }, [{ goal: "repair" }]); return { offered: outcome.capabilities.length, replacement: outcome.replaceContext, evidence: library.snapshot()[0].evidence }',
      { library: fixture.library, source, environment: { workspace, files: [] } },
    ),
  ).toMatchObject({ offered: 0, evidence: [{ result: { ok: false } }] })
})

test("reloads large source and evidence through the actual paginated read tool without losing bytes", async () => {
  const fixture = await setup()
  const workspace = await fixture.workspace("large", 2)
  const source = repair + "\nconst padding = " + JSON.stringify("x".repeat(6000)) + ";"
  const evidence = "long output ".repeat(40000)
  expect(
    await fixture.run(
      "const library = capabilityLibrary(input.library); const admitted = library.admit(input.source, input.environment); library.record(admitted.entry.ref, { output: input.evidence }); return library.snapshot().length",
      { library: fixture.library, source, evidence, environment: { workspace, files: [] } },
    ),
  ).toBe(1)
  expect(Bun.file(fixture.library).size).toBeGreaterThan(ReadToolFileSystem.MAX_READ_BYTES)
  expect(
    await fixture.run(
      "const library = capabilityLibrary(input.library); return { source: library.snapshot()[0].source === input.source, evidence: library.snapshot()[0].evidence[0].output === input.evidence }",
      { library: fixture.library, source, evidence },
    ),
  ).toEqual({ source: true, evidence: true })
})

async function repository(fixture: Awaited<ReturnType<typeof setup>>, name: string) {
  const workspace = await fixture.workspace(name, 6)
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: workspace }).exitCode).toBe(0)
  await Bun.write(
    path.join(workspace, "AGENTS.md"),
    "Preserve unrelated changes. Run package checks in their own directory.\n",
  )
  expect(Bun.spawnSync(["git", "add", "."], { cwd: workspace }).exitCode).toBe(0)
  expect(
    Bun.spawnSync(
      ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "baseline"],
      { cwd: workspace },
    ).exitCode,
  ).toBe(0)
  return workspace
}

test("Jev checkpoints, resumes a generated repair in a new execution, and returns a real diff", async () => {
  const fixture = await setup()
  const workspace = await repository(fixture, "daily")
  const settings = { workspace, stateDirectory: fixture.root + "/daily-state", taskID: "daily" }
  expect(
    await fixture.run("return jevRun(input, input.settings)", {
      text: JSON.stringify({ goal: "Repair double", maxSteps: 1 }),
      settings,
    }),
  ).toMatchObject({ status: "paused", generations: 1, steps: 1 })
  expect(await fixture.run("return jevRun(input, input.settings)", { text: "resume", settings })).toMatchObject({
    status: "quit",
    generations: 1,
  })
  expect(await fixture.run("return jevRun(input, input.settings)", { text: "status", settings })).toMatchObject({
    status: "quit",
    changes: { diff: { exit: 0, output: expect.stringContaining("+  return n * 2") } },
  })
  expect(fixture.generations).toHaveLength(1)
  expect(Bun.spawnSync(["bun", "test"], { cwd: workspace }).exitCode).toBe(0)
  expect(fixture.generations[0]).toMatchObject({ context: { instructions: [{ path: workspace + "/AGENTS.md" }] } })
})

test("Jev shares reusable source between tasks, archives task history, and preserves unrelated changes", async () => {
  const fixture = await setup()
  const first = await repository(fixture, "first-daily")
  const second = await repository(fixture, "second-daily")
  await Bun.write(path.join(second, "user-notes.txt"), "User work must survive\n")
  const settings = { workspace: first, stateDirectory: fixture.root + "/shared-state", taskID: "shared" }
  expect(await fixture.run("return jevRun(input, input.settings)", { text: "Repair double", settings })).toMatchObject({
    status: "quit",
  })
  expect(
    await fixture.run("return jevRun(input, input.settings)", {
      text: JSON.stringify({ action: "new", goal: "Repair double for another input", workspace: second }),
      settings,
    }),
  ).toMatchObject({ status: "quit", generations: 0 })
  expect(fixture.generations).toHaveLength(1)
  expect(await Bun.file(path.join(second, "user-notes.txt")).text()).toBe("User work must survive\n")
  expect(await Array.fromAsync(new Bun.Glob("shared-*.json").scan(settings.stateDirectory + "/tasks"))).toHaveLength(1)
})

test("Jev persists corrections and does not reset a zero generation budget on resume", async () => {
  const fixture = await setup()
  const workspace = await repository(fixture, "budget")
  const settings = { workspace, stateDirectory: fixture.root + "/budget-state", taskID: "budget" }
  expect(
    await fixture.run("return jevRun(input, input.settings)", {
      text: JSON.stringify({ goal: "Inspect double", maxGenerations: 0, maxSteps: 1 }),
      settings,
    }),
  ).toMatchObject({ generations: 0, generationBudget: 0 })
  expect(
    await fixture.run("return jevRun(input, input.settings)", { text: "Only explain the bug; do not edit", settings }),
  ).toMatchObject({ goal: "Only explain the bug; do not edit", generations: 0, generationBudget: 0 })
  expect(fixture.generations).toHaveLength(0)
})

test("Jev records uncertain interrupted effects and recovers from the checkpoint instead of replaying a batch", async () => {
  const fixture = await setup()
  const workspace = await repository(fixture, "interruption")
  const settings = { workspace, stateDirectory: fixture.root + "/interrupt-state", taskID: "interrupt" }
  await fixture.run("return jevRun(input, input.settings)", {
    text: JSON.stringify({ goal: "Repair double", maxSteps: 1 }),
    settings,
  })
  await fixture.run(
    'const file = jevFile(input.path); file.save({ ...file.value, pending: { phase: "execute", capability: "library:repair-double@1" } }); return true',
    { path: settings.stateDirectory + "/tasks/interrupt.json" },
  )
  expect(await fixture.run("return jevRun(input, input.settings)", { text: "resume", settings })).toMatchObject({
    status: "quit",
    pending: null,
  })
  expect(
    await fixture.run(
      'return jevFile(input.path).value.context.some((entry) => entry.capability === "recovery" && entry.state.instructions.includes("may already have changed files"))',
      { path: settings.stateDirectory + "/tasks/interrupt.json" },
    ),
  ).toBe(true)
})

test("Jev skips checkpointed actions when recovering a partially completed batch", async () => {
  const fixture = await setup()
  const workspace = await repository(fixture, "partial")
  const settings = { workspace, stateDirectory: fixture.root + "/partial-state", taskID: "partial" }
  await fixture.run("return jevRun(input, input.settings)", {
    text: JSON.stringify({ goal: "Repair double", maxSteps: 1 }),
    settings,
  })
  const checkpoint = settings.stateDirectory + "/tasks/partial.json"
  await fixture.run(
    'const file = jevFile(input.path); file.save({ ...file.value, batchCompleted: ["quit", "compact", "repository-search", "project-checks", "factory", "library:repair-double@1"], pending: { phase: "execute", capability: "other" } }); return true',
    { path: checkpoint },
  )
  await fixture.run("return jevRun(input, input.settings)", {
    text: JSON.stringify({ action: "resume", maxSteps: 1 }),
    settings,
  })
  expect(
    await fixture.run("return jevFile(input.path).value.trace.slice(-1)[0].outcomes", { path: checkpoint }),
  ).toEqual([])
})

test("Jev follows paginated project instructions instead of silently truncating them", async () => {
  const fixture = await setup()
  const workspace = await repository(fixture, "instructions")
  await Bun.write(path.join(workspace, "AGENTS.md"), "Instruction line.\n".repeat(4000) + "Critical rule at the end.")
  expect(
    await fixture.run(
      'return jevProject(input.workspace, "Inspect").instructions.find((entry) => entry.path === input.workspace + "/AGENTS.md").content.endsWith("Critical rule at the end.")',
      { workspace },
    ),
  ).toBe(true)
})

test("Jev distinguishes exact ancestor instructions from nested matches", async () => {
  const fixture = await setup()
  const workspace = await repository(fixture, "exact-instructions")
  await Bun.write(path.join(fixture.root, "AGENTS.md"), "Ancestor instructions")
  await Bun.write(path.join(fixture.root, "sibling/AGENTS.md"), "Not applicable")
  const instructions = await fixture.run('return jevProject(input.workspace, "Inspect").instructions', { workspace })
  expect(instructions).toEqual(
    expect.arrayContaining([
      { path: fixture.root + "/AGENTS.md", content: "Ancestor instructions" },
      { path: workspace + "/AGENTS.md", content: expect.stringContaining("Preserve unrelated") },
    ]),
  )
  expect(JSON.stringify(instructions)).not.toContain("Not applicable")
})

test("Jev runs through the same nested confined evaluator used by the installed command", async () => {
  const fixture = await setup()
  const workspace = await repository(fixture, "nested")
  const settings = { workspace, stateDirectory: fixture.root + "/nested-state", taskID: "nested" }
  expect(
    await fixture.run(
      'return tools.capability.evaluate({ code: input.source, input: { command: { text: "Repair double" }, settings: input.settings }, tools: ["capability.evaluate", "decision.ask", "generate.code", "glob", "read", "patch", "shell", "display_result"], maxToolCalls: 100, timeoutMs: 120000 })',
      { source: "{\n" + scripts.join("\n") + "\nreturn jevRun(input.command, input.settings);\n}", settings },
    ),
  ).toMatchObject({ ok: true, value: { status: "quit" } })
})

test("Jev bounds handoff previews without changing durable observations", async () => {
  const fixture = await setup()
  const task = {
    status: "paused",
    goal: "Inspect",
    workspace: fixture.root,
    trace: [],
    generations: 0,
    maxGenerations: 0,
    pending: null,
    context: [{ capability: "factory", state: { source: "x".repeat(4000) } }],
    review: { diff: { output: "x".repeat(20000), truncated: false } },
  }
  expect(
    await fixture.run(
      'return { report: jevReport(input.task, "checkpoint"), original: input.task.context[0].state.source.length }',
      { task },
    ),
  ).toMatchObject({
    report: {
      recent: [{ state: { preview: expect.any(String), truncated: true } }],
      changes: { diff: { output: "x".repeat(16000), truncated: true } },
    },
    original: 4000,
  })
})

test("Jev bounds oversized judgment views without rewriting execution context", async () => {
  const fixture = await setup([])
  const result = await fixture.run(
    [
      'const context = [{ goal: "explain the repo" }, { capability: "repository", state: { content: "old" } }, { capability: "repository", state: { content: input.content } }, { capability: "user", state: { correction: "explain without edits" } }];',
      "const before = JSON.stringify(context);",
      'const questions = { "0.useful": { type: "noul", instructions: "Is more evidence needed?" } };',
      'const state = jevJudgment(context, [{ id: "inspect", state: input.content }], questions);',
      'return { size: JSON.stringify(state).length + JSON.stringify(questions).length, unchanged: before === JSON.stringify(context), full: context[2].state.content.length, goal: state.context[0], correction: state.context.slice(-1)[0], truncated: JSON.stringify(state).includes("truncated") };',
    ].join("\n"),
    { content: "x".repeat(250000) },
  )
  expect(result).toMatchObject({
    unchanged: true,
    full: 250000,
    goal: { goal: "explain the repo" },
    correction: { capability: "user", state: { correction: "explain without edits" } },
    truncated: true,
  })
  expect(result).toHaveProperty("size", expect.any(Number))
  expect(Number((result as { size: number }).size)).toBeLessThanOrEqual(8000)
  const crowded = await fixture.run(
    [
      'const questions = { useful: { type: "noul", instructions: "Useful?" } };',
      'const context = [{ goal: "inspect" }, ...Array.from({ length: 200 }, (_, index) => ({ capability: "evidence", state: { index, content: input.content } }))];',
      'const capabilities = Array.from({ length: 100 }, (_, index) => ({ id: "cap-" + index, state: input.content }));',
      "return JSON.stringify(jevJudgment(context, capabilities, questions)).length + JSON.stringify(questions).length;",
    ].join("\n"),
    { content: '\n"\\'.repeat(1000) },
  )
  expect(crowded).toBeLessThanOrEqual(8000)
})

test("Jev resumes an oversized checkpoint without duplicating unchanged repository discovery", async () => {
  const fixture = await setup([])
  const workspace = await repository(fixture, "oversized")
  const settings = { workspace, stateDirectory: fixture.root + "/daily-state", taskID: "oversized" }
  await fixture.run("return jevRun(input, input.settings)", {
    text: JSON.stringify({ goal: "Explain the repository", maxSteps: 1, maxGenerations: 0 }),
    settings,
  })
  const checkpoint = settings.stateDirectory + "/tasks/oversized.json"
  await fixture.run(
    'const file = jevFile(input.path); file.save({ ...file.value, context: [...file.value.context, { capability: "large-evidence", state: input.content }], pending: { phase: "judgment", step: 1 } }); return true',
    { path: checkpoint, content: "evidence".repeat(40000) },
  )
  const before = JSON.parse((await Bun.file(checkpoint).json()).chunks.join(""))
  expect(
    await fixture.run("return jevRun(input, input.settings)", {
      text: JSON.stringify({ action: "resume", maxSteps: 1 }),
      settings,
    }),
  ).toMatchObject({ status: "paused", steps: 2, pending: null, generations: 0 })
  const after = JSON.parse((await Bun.file(checkpoint).json()).chunks.join(""))
  expect(after.context.slice(0, before.context.length)).toEqual(before.context)
  expect(after.context.filter((entry: { capability?: string }) => entry.capability === "repository")).toHaveLength(1)
  fixture.batches.forEach((batch) => expect(JSON.stringify(batch).length).toBeLessThanOrEqual(8100))
})

test("Jev refuses oversized question sets instead of silently dropping capability policies", async () => {
  const fixture = await setup([])
  await expect(
    fixture.run(
      'return jevJudgment([{ goal: "inspect" }], [], { useful: { type: "noul", instructions: input.large } })',
      {
        large: "x".repeat(5000),
      },
    ),
  ).rejects.toThrow("4000-character judgment budget")
})

test("Jev reports a missing evaluator before reading sources or touching task state", async () => {
  const installer = await Bun.file(
    new URL("../../../.ocpp/experiments/decision-loop/install.js", import.meta.url),
  ).text()
  const calls: string[] = []
  const result = await Effect.runPromise(
    Effect.scoped(
      CodeMode.execute({
        code:
          "const jevDailySettings = {};\n" +
          installer.slice(installer.indexOf("function jevDailyCommand"), installer.indexOf("\ntools.command.define(")) +
          '\nreturn jevDailyCommand({ text: "tell me about this repo" });',
        tools: CodeModeTool.tools(
          new Map([
            [
              "display_result",
              {
                name: "display_result",
                description: "Show the missing evaluator diagnostic",
                input: Schema.Json,
                output: Schema.Json,
                execute: () =>
                  Effect.sync(() => {
                    calls.push("display_result")
                    return { output: { id: "diagnostic" } }
                  }),
              },
            ],
          ]),
          (_name, tool, input) =>
            tool
              .execute(input, {
                sessionID: Session.ID.make("ses_missing_evaluator"),
                agent: Agent.ID.make("build"),
                messageID: SessionMessage.ID.make("msg_missing_evaluator"),
                id: Tool.CallID.make("call_missing_evaluator"),
                progress: () => Effect.void,
              })
              .pipe(Effect.map((result) => result.output)),
        ),
      }),
    ),
  )
  expect(result).toMatchObject({
    ok: true,
    value: { status: "unavailable", error: expect.stringContaining("server handling this command") },
  })
  expect(calls).toEqual(["display_result"])
})
