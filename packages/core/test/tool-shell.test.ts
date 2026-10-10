import fs from "fs/promises"
import { realpathSync } from "node:fs"
import os from "os"
import path from "path"
import { describe, expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Schema, Scope, Stream } from "effect"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { filesystem } from "@ocpp/util/effect/app-node-platform"
import { Database } from "@ocpp/core/database/database"
import { CodeModeCatalog } from "@ocpp/core/codemode/catalog"
import { CodeModeInstructions } from "@ocpp/core/codemode/instructions"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { Bus } from "@ocpp/core/bus"
import { Config } from "@ocpp/core/config"
import { Environment } from "@ocpp/core/environment/index"
import { FSUtil } from "@ocpp/util/fs-util"
import { Global } from "@ocpp/util/global"
import { Location } from "@ocpp/core/location"
import { LocationMutation } from "@ocpp/core/location-mutation"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import { Model } from "@ocpp/core/model"
import { Provider } from "@ocpp/core/provider"
import { AbsolutePath } from "@ocpp/core/schema"
import { Job } from "@ocpp/core/job"
import { Session } from "@ocpp/core/session"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionExecution } from "@ocpp/core/session/execution"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { PluginHooks } from "@ocpp/core/plugin/hooks"
import { PluginSupervisor } from "@ocpp/core/plugin/supervisor"
import { Shell } from "@ocpp/core/shell"
import { ShellSelect } from "@ocpp/core/shell/select"
import { Shell as ShellSchema } from "@ocpp/schema/shell"
import { ShellTool } from "@ocpp/core/tool/plugin/shell"
import { ToolOutput } from "@ocpp/core/tool-output"
import { Tool } from "@ocpp/core/tool"
import { definition } from "@ocpp/core/tool/runtime"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"
import { TestStepHost } from "./fixture/step-host"
import { Expected } from "./lib/session-message"
import {
  codeModeTools,
  executeTool,
  readCodeModeNotebook,
  seedToolSession,
  registerToolPlugin,
  registeredTools,
  toolDefinitions,
  toolIdentity,
  waitForCodeMode,
} from "./lib/tool"

const sessionID = Session.ID.make("ses_shell_tool_test")
const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })

// The runtime runs every Session; a step produces nothing unless a test scripts one.
const steps = TestStepHost.make()

const shellPluginSupervisor = makeLocationNode({
  service: PluginSupervisor.Service,
  layer: Layer.effect(
    PluginSupervisor.Service,
    registerToolPlugin(ShellTool.Plugin).pipe(Effect.as(PluginSupervisor.Service.of({ flush: Effect.void }))),
  ),
  deps: [
    Config.node,
    Environment.node,
    LocationMutation.node,
    PluginHooks.node,
    PluginRuntime.node,
    Shell.node,
    ShellSelect.node,
    Tool.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  CodeModeStore.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  PluginRuntime.providerNode,
  LocationServiceMap.node,
  filesystem,
  FSUtil.node,
  Global.node,
])
const replacements = [steps.replacement, [Global.node, tempGlobalLayer]] satisfies LayerNode.Replacements
const productionIt = testEffect(AppNodeBuilder.build(nodes, replacements))
const it = testEffect(AppNodeBuilder.build(nodes, [...replacements, [PluginSupervisor.node, shellPluginSupervisor]]))

const call = (input: typeof ShellTool.Input.Type, id = "call-shell") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "shell", input },
})

const isWindows = process.platform === "win32"
const cwdCommand = isWindows ? "(Get-Location).Path; Start-Sleep -Milliseconds 100" : "pwd"
const helloCommand = isWindows ? "[Console]::Out.Write('hello'); Start-Sleep -Milliseconds 100" : "printf hello"
const stderrCommand = isWindows
  ? "[Console]::Error.Write('stderr only'); Start-Sleep -Milliseconds 100"
  : "printf 'stderr only' >&2"
const mixedOutputCommand = isWindows
  ? "[Console]::Out.Write('stdout'); Start-Sleep -Milliseconds 50; [Console]::Error.Write('stderr'); Start-Sleep -Milliseconds 100"
  : "printf stdout; sleep 0.05; printf stderr >&2"
const idleCommand = isWindows ? "Start-Sleep -Seconds 60" : "sleep 60"
const timeoutOutputCommand = isWindows
  ? "[Console]::Out.Write('before timeout'); Start-Sleep -Seconds 60"
  : "printf 'before timeout'; sleep 60"
const bodyExitCommand = isWindows
  ? "[Console]::Out.Write('body'); Start-Sleep -Milliseconds 100; exit 7"
  : "printf body && exit 7"
const overflowCommand = (bytes: number) =>
  isWindows
    ? `[Console]::Out.Write('output-start' + ('x' * ${bytes}) + 'output-end'); Start-Sleep -Milliseconds 100`
    : `printf output-start; head -c ${bytes} /dev/zero | tr '\\0' 'x'; printf output-end`
const lineOverflowCommand = isWindows
  ? "[Console]::Out.Write('one' + [Environment]::NewLine + 'two' + [Environment]::NewLine + 'three')"
  : "printf 'one\\ntwo\\nthree'"
const progressOverflowCommand = (bytes: number, release: string) =>
  isWindows
    ? `[Console]::Out.Write(('x' * ${bytes})); while (!(Test-Path -LiteralPath '${release}')) { Start-Sleep -Milliseconds 50 }`
    : `head -c ${bytes} /dev/zero | tr '\\0' 'x'; while [ ! -e '${release}' ]; do sleep 0.05; done`

const withSession = <A, E, R>(directory: string, body: (registry: Tool.Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    yield* sessions.create({
      id: sessionID,
      title: "shell test",
      location,
      model: sessionModel,
    })
    const locations = yield* LocationServiceMap.Service
    const locationLayer = locations.get(location)
    return yield* Effect.gen(function* () {
      const plugins = yield* PluginSupervisor.Service
      yield* plugins.flush
      const registry = yield* Tool.Service
      return yield* body(registry)
    }).pipe(Effect.provide(locationLayer), Effect.ensuring(locations.invalidate(location)))
  })

const withShell = <A, E, R>(
  body: (registry: Tool.Interface, directory: string) => Effect.Effect<A, E, R>,
  shell = "sh",
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      withSession(tmp.path, (registry) =>
        Effect.gen(function* () {
          const selection = yield* ShellSelect.Service
          yield* selection.transform((draft) => draft.configure(shell))
          return yield* body(registry, tmp.path)
        }),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
  )

describe("ShellTool ordinary shell syntax", () => {
  for (const shell of ["bash", "zsh"]) {
    const test = isWindows || !Bun.which(shell) ? it.live.skip : it.live
    for (const fixture of [
      { name: "quoted heredoc", command: "cat <<'EOF'\nhello\nEOF", output: "hello\n" },
      { name: "heredoc substitution", command: "cat <<EOF\n$(printf hello)\nEOF", output: "hello\n" },
      {
        name: "loop with a conditional",
        command: 'for value in a b; do if test -n "$value"; then printf %s "$value"; fi; done',
        output: "ab",
      },
      {
        name: "function and case",
        command: 'greet() { case "$1" in a) printf hello;; *) printf other;; esac; }; greet a',
        output: "hello",
      },
      { name: "parameter fallback", command: 'value=; printf %s "${value:-fallback}"', output: "fallback" },
      { name: "arithmetic statement", command: 'count=1; ((count += 1)); printf %s "$count"', output: "2" },
      { name: "ANSI-C quoting", command: "printf %s $'a\\nb'", output: "a\nb" },
    ]) {
      test(`${shell}: runs ${fixture.name}`, () =>
        withShell(
          (registry) =>
            Effect.gen(function* () {
              expect(yield* executeTool(registry, call({ command: fixture.command }))).toMatchObject({
                status: "completed",
                metadata: { exit: 0 },
                content: [{ type: "text", text: fixture.output }, { type: "text" }],
              })
            }),
          shell,
        ))
    }
  }

  const pwsh = process.env.SHELL_SCAN_PWSH ?? Bun.which("pwsh") ?? Bun.which("powershell")
  const test = pwsh ? it.live : it.live.skip
  for (const command of [
    'Write-Output "$(Write-Output hello)"',
    '$value = "hello"; Write-Output $value',
    "if ($true) { Write-Output hello } else { Write-Output other }",
    "foreach ($value in @('hello')) { Write-Output $value }",
    "ForEach-Object { Write-Output hello }",
    "function Show-Value { Write-Output hello }; Show-Value",
    "Write-Output `\n  hello",
    "Write-Output @'\nhello\n'@",
  ]) {
    test(`PowerShell: runs ordinary syntax: ${command}`, () =>
      withShell(
        (registry) =>
          Effect.gen(function* () {
            const settled = yield* executeTool(registry, call({ command }))
            expect(settled).toMatchObject({ status: "completed", metadata: { exit: 0 } })
            expect(settled.content?.[0]).toEqual(Expected.text(isWindows ? "hello\r\n" : "hello\n"))
          }),
        pwsh ?? "pwsh",
      ))
  }
})

describe("ShellTool", () => {
  it.live("names the OS and shell in the description the catalog and tools.search show", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const selection = yield* ShellSelect.Service
            yield* selection.transform((draft) => draft.configure("sh"))
            const shell = ShellSelect.name(yield* selection.resolve({ priority: "compat" }))
            const snapshot = yield* registry.snapshot()
            const described = snapshot.codeModeCatalog?.find((tool) => tool.path === ShellTool.name)?.description ?? ""
            expect(described).toMatch(
              new RegExp(`^Execute a shell command and return its output\\. Commands run on \\S+ using ${shell}\\. `),
            )
            // The catalog shows the first 120 characters of the description, which include the line.
            expect(CodeModeInstructions.render(CodeModeCatalog.summarize(snapshot.codeModeCatalog ?? []))).toContain(
              "// " + described.slice(0, 80),
            )

            yield* seedToolSession(sessionID, toolIdentity.messageID)
            const started = yield* snapshot.execute({
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-search-shell",
                name: "execute",
                input: { code: 'const shellSearch = tools.search({ query: "tools.shell" })' },
              },
            })
            expect(
              yield* waitForCodeMode(started.output, {
                sessionID,
                assistantMessageID: toolIdentity.messageID,
                id: "call-search-shell",
              }),
            ).toMatchObject({ status: "saved", saved: ["shellSearch"] })
            expect((yield* readCodeModeNotebook(sessionID)).shellSearch).toMatchObject({
              items: [{ path: "tools.shell", description: described }],
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("returns both sequential Code Mode shell results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* seedToolSession(sessionID, toolIdentity.messageID)
            const command = isWindows ? helloCommand : `${helloCommand}; sleep 0.1`
            const inputs = ["one", "two"].map((text) => JSON.stringify({ command: command.replace("hello", text) }))
            const result = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-parallel-shells",
                name: "execute",
                input: { code: `const shells = [tools.shell(${inputs[0]}), tools.shell(${inputs[1]})]` },
              },
            }).pipe(Effect.timeout("3 seconds"))
            expect(result.status).toBe("completed")
            expect(
              yield* waitForCodeMode(result.output, {
                sessionID,
                assistantMessageID: toolIdentity.messageID,
                id: "call-parallel-shells",
              }),
            ).toMatchObject({ status: "saved", saved: ["shells"] })
            expect(yield* readCodeModeNotebook(sessionID)).toMatchObject({
              shells: [
                { output: "one", exit: 0, truncated: false, status: "completed" },
                { output: "two", exit: 0, truncated: false, status: "completed" },
              ],
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  productionIt.live(
    "registers and returns real successful output from the active Location",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["execute"])
              expect(yield* codeModeTools(registry)).toContain("shell")
              const shell = (yield* registeredTools(registry)).get("shell")
              expect(shell).toBeDefined()
              if (!shell) return
              const shellDefinition = definition(shell)
              expect(shellDefinition.description).toStartWith("Execute a shell command and return its output.")
              expect(shellDefinition.inputSchema).not.toHaveProperty("properties.timeout.maximum")
              // Code Mode receives the declared output schema, including the command output text.
              expect(shellDefinition.outputSchema).toHaveProperty("properties.output")
              expect(yield* codeModeTools(registry, { paths: ["read", "glob"] })).toEqual([
                "glob",
                "notebook.inspect",
                "notebook.list",
                "read",
              ])

              const settled = yield* executeTool(registry, call({ command: helloCommand }))
              expect(settled.status).toBe("completed")
              expect(settled.metadata).toMatchObject({ exit: 0, truncated: false })
              expect(settled.content?.[0]).toEqual({ type: "text", text: "hello" })
              expect(settled.content?.[1]).toMatchObject(
                Expected.text(expect.stringContaining("Command exited with code 0.")),
              )
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  productionIt.live(
    "uses the session environment instead of the server environment",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              yield* sessions.environment({
                sessionID,
                variables: { OCPP_SESSION_ENV_TEST: "from-session" },
              })
              const command = isWindows
                ? "[Console]::Out.Write($env:OCPP_SESSION_ENV_TEST)"
                : 'printf %s "$OCPP_SESSION_ENV_TEST"'

              const settled = yield* executeTool(registry, call({ command }))

              expect(settled.status).toBe("completed")
              expect(settled.content?.[0]).toEqual({ type: "text", text: "from-session" })
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withSession(tmp.path, (registry) => executeTool(registry, call({ command: cwdCommand, workdir: "src" }))),
          ),
          Effect.andThen((settled) =>
            Effect.sync(() =>
              expect(settled.content?.[0]).toMatchObject(
                Expected.text(expect.stringContaining(realpathSync(path.join(tmp.path, "src")))),
              ),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("reports a missing workdir", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        return withSession(tmp.path, (registry) =>
          executeTool(registry, call({ command: cwdCommand, workdir: "missing" })),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() =>
              expect(settled).toEqual({
                status: "error",
                error: {
                  type: "unknown",
                  message: `Working directory does not exist: ${path.join(tmp.path, "missing")}`,
                },
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "captures stderr-only and mixed stdout/stderr output",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const stderr = yield* executeTool(registry, call({ command: stderrCommand }, "call-stderr"))
              expect(stderr.metadata).toMatchObject({ exit: 0, truncated: false })
              expect(stderr.content?.[0]).toEqual({ type: "text", text: "stderr only" })

              const mixed = yield* executeTool(registry, call({ command: mixedOutputCommand }, "call-mixed"))
              expect(mixed.metadata).toMatchObject({ exit: 0, truncated: false })
              const output = mixed.content?.[0]?.type === "text" ? mixed.content[0].text : ""
              expect(output).toContain("stdout")
              expect(output).toContain("stderr")
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live(
    "runs in an explicit external workdir",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) => {
          return withSession(active.path, (registry) =>
            executeTool(registry, call({ command: cwdCommand, workdir: outside.path })),
          ).pipe(Effect.andThen(Effect.sync(() => {})))
        },
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    { timeout: 15_000 },
  )

  it.live("changes into the expanded home directory", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const command = isWindows ? "Set-Location $HOME; (Get-Location).Path" : "cd ~ && pwd"
        return withSession(tmp.path, (registry) => executeTool(registry, call({ command }, "call-external-home"))).pipe(
          Effect.andThen(Effect.sync(() => {})),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("runs malformed syntax through the shell, which reports it", () =>
    Effect.gen(function* () {
      if (isWindows) return
      yield* withShell((registry, directory) =>
        Effect.gen(function* () {
          const settled = yield* executeTool(
            registry,
            call({ command: 'printf hello > marker\necho "' }, "call-malformed"),
          )
          expect(settled.status).toBe("completed")
          expect(settled.metadata?.exit).not.toBe(0)
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "marker")).text())).toBe("hello")
        }),
      )
    }),
  )

  for (const shell of ["sh", "zsh"]) {
    const test = isWindows || !Bun.which(shell) ? it.live.skip : it.live
    test(
      `runs arithmetic and directory changes in ${shell}`,
      () =>
        withShell(
          (registry, directory) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => fs.mkdir(path.join(directory, "one", "two"), { recursive: true }))
              for (const [command, output] of [
                ["echo $((1 + 1))", "2\n"],
                ["cd ~ && pwd", `${realpathSync(os.homedir())}\n`],
                ["cd one&&cd two&&pwd", `${path.join(directory, "one", "two")}\n`],
              ]) {
                const settled = yield* executeTool(registry, call({ command }, `call-parity-${command}`))
                expect(settled.status).toBe("completed")
                expect(settled.metadata).toMatchObject({ exit: 0 })
                expect(settled.content?.[0]).toMatchObject({ type: "text", text: output })
              }
            }),
          shell,
        ),
      { timeout: 15_000 },
    )
  }

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        return withSession(tmp.path, (registry) =>
          executeTool(registry, call({ command: bodyExitCommand }, "call-nonzero")),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.status).toBe("completed")
              expect(settled.metadata).toMatchObject({ exit: 7, truncated: false })
              expect(settled.content?.[0]).toEqual({ type: "text", text: "body" })
              expect(settled.content?.[1]).toMatchObject(
                Expected.text(expect.stringContaining("Command exited with code 7")),
              )
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "truncates the model view and points at the saved output file when output overflows",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          const bytes = ToolOutput.MAX_BYTES + 1024
          return withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: overflowCommand(bytes) }, "call-overflow")),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.metadata).toMatchObject({ exit: 0, truncated: true })
                const content = settled.content?.[0]
                if (!content || content.type !== "text") throw new Error("Expected text content")
                expect(content.text.includes("output-start")).toBe(false)
                expect(content.text.includes("output-end")).toBe(true)
                expect(content).toMatchObject(
                  Expected.text(expect.stringContaining("output truncated; full output saved to:")),
                )
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("uses configured line limits", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        return Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(tmp.path, "ocpp.json"),
              JSON.stringify({ tool_output: { max_lines: 2, max_bytes: 1_000 } }),
            ),
          )
          const settled = yield* withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: lineOverflowCommand }, "call-line-overflow")),
          )
          expect(settled.metadata).toMatchObject({ exit: 0, truncated: true })
          const content = settled.content?.[0]
          if (!content || content.type !== "text") throw new Error("Expected text content")
          expect(content.text).not.toContain("one")
          // Windows shells emit CRLF; the assertion targets line limits, not line endings.
          expect(content.text.replaceAll("\r\n", "\n")).toStartWith("two\nthree")
          expect(content.text).toContain("output truncated; full output saved to:")
        })
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "reports the shell ID for a running command",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          const release = "shell-progress-release"
          const releasePath = path.join(tmp.path, release)
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const observed = yield* Deferred.make<string>()
              yield* executeTool(registry, {
                ...call({ command: progressOverflowCommand(ToolOutput.MAX_BYTES + 1024, release) }, "call-progress"),
                progress: (update) =>
                  Effect.gen(function* () {
                    if (typeof update.shellID !== "string") return
                    yield* Deferred.succeed(observed, update.shellID)
                    yield* Effect.promise(() => fs.writeFile(releasePath, ""))
                  }),
              })

              expect(yield* Deferred.await(observed)).toMatch(/^sh_/)
            }).pipe(Effect.ensuring(Effect.promise(() => fs.writeFile(releasePath, "")).pipe(Effect.ignore))),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live(
    "reports shell ID progress once",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const updates: Tool.Metadata[] = []
              yield* executeTool(registry, {
                ...call({ command: helloCommand }, "call-shell-id-progress"),
                progress: (update) => Effect.sync(() => updates.push(update)),
              })
              expect(updates).toHaveLength(1)
              expect(updates[0]?.shellID).toMatch(/^sh_/)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live(
    "runs the hook-edited command and workdir and reports its timeout",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          const timeout = isWindows ? 3_000 : 500
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const hooks = yield* PluginHooks.Service
              yield* hooks.register("shell", "create.before", (invocation) =>
                Effect.sync(() => {
                  invocation.command = timeoutOutputCommand
                  invocation.cwd = tmp.path
                  invocation.timeout = timeout
                }),
              )
              return yield* executeTool(registry, call({ command: helloCommand, workdir: "missing", timeout: 60_000 }))
            }),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.metadata).toMatchObject({ timeout: true, truncated: false })
                expect(settled.metadata).not.toHaveProperty("exit")
                const content = settled.content?.[0]
                expect(content?.type).toBe("text")
                if (content?.type !== "text") throw new Error("Expected text content")
                expect(content.text).toContain("before timeout")
                expect(content.text).toContain(`Command exceeded timeout of ${timeout} ms.`)
                expect(settled.content?.[1]).toMatchObject(Expected.text(expect.stringContaining("Command timed out")))
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("returns the shell id for a background command", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
              Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            )
            const settled = yield* executeTool(registry, call({ command: idleCommand, timeout: 50, background: true }))
            const shellID = typeof settled.metadata?.shellID === "string" ? settled.metadata.shellID : undefined
            expect(settled.metadata).toMatchObject({ truncated: false })
            expect(shellID).toStartWith("sh_")

            const shell = yield* Shell.Service
            if (!shellID) return
            const id = ShellSchema.ID.make(shellID)
            const info = yield* shell.get(id)
            expect(settled.content).toEqual([
              {
                type: "text",
                text: `Command moved to the background (shell ID: ${shellID}).\nOutput is streaming to: ${info.file}`,
              },
              {
                type: "text",
                text: "You will be notified automatically when the command finishes. The notification will include the command's output. DO NOT run sleep commands or poll the output file to check for completion. You can read from the file when its current output would be useful, such as when inspecting logs from a background server. Otherwise, continue with other work or end your response.",
              },
            ])
            expect((yield* shell.list()).map((info) => info.id)).toContain(id)
            expect((yield* shell.wait(id)).status).toBe("timeout")
            expect((yield* Fiber.join(admitted)).valueOrUndefined?.data.item.payload).toMatchObject({
              text: expect.stringContaining("Command timed out before completion."),
              description: idleCommand,
              metadata: {
                source: "shell",
                shellID,
                state: "completed",
                timeout: true,
                truncated: false,
              },
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("preserves a background command's non-zero exit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
              Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            )
            const settled = yield* executeTool(
              registry,
              call({ command: bodyExitCommand, background: true }, "call-background-nonzero"),
            )
            const shellID = settled.metadata?.shellID
            expect(typeof shellID).toBe("string")
            expect((yield* Fiber.join(admitted)).valueOrUndefined?.data.item.payload).toMatchObject({
              text: expect.stringContaining("Command exited with code 7."),
              description: bodyExitCommand,
              metadata: {
                source: "shell",
                jobID: shellID,
                shellID,
                state: "completed",
                exit: 7,
                truncated: false,
              },
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("persists a silent command that finishes before backgrounding", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const jobs = yield* Job.Service
            const shell = yield* Shell.Service
            const persisted = yield* Deferred.make<readonly Job.Background[]>()
            yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
              event.data.sessionID === sessionID && event.data.item.type === "synthetic"
                ? jobs.pendingBackground.pipe(
                    Effect.flatMap((background) => Deferred.succeed(persisted, background)),
                    Effect.asVoid,
                  )
                : Effect.void,
            )
            const settled = yield* executeTool(registry, {
              ...call({ command: "exit 7", background: true }, "call-background-silent-nonzero"),
              // The command can finish while its initial progress update is being published.
              progress: (update) =>
                typeof update.shellID === "string"
                  ? shell.wait(ShellSchema.ID.make(update.shellID)).pipe(Effect.orDie, Effect.asVoid)
                  : Effect.void,
            })

            expect(yield* Deferred.await(persisted)).toMatchObject([
              {
                id: settled.metadata?.shellID,
                status: "completed",
                output: "(no output)\n\nCommand exited with code 7.",
              },
            ])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "updates and clears a running shell timeout",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const shell = yield* Shell.Service
              const timed = yield* executeTool(
                registry,
                call({ command: idleCommand, background: true }, "call-updated-timeout"),
              )
              const timedID = timed.metadata?.shellID
              expect(typeof timedID).toBe("string")
              if (typeof timedID !== "string") return
              const timedShellID = ShellSchema.ID.make(timedID)
              yield* shell.timeout(timedShellID, 50)
              expect((yield* shell.wait(timedShellID)).status).toBe("timeout")

              const cleared = yield* executeTool(
                registry,
                call({ command: idleCommand, timeout: 50, background: true }, "call-cleared-timeout"),
              )
              const clearedID = cleared.metadata?.shellID
              expect(typeof clearedID).toBe("string")
              if (typeof clearedID !== "string") return
              const clearedShellID = ShellSchema.ID.make(clearedID)
              yield* shell.timeout(clearedShellID, 0)
              yield* Effect.sleep(Duration.millis(100))
              expect((yield* shell.get(clearedShellID)).status).toBe("running")
              yield* shell.remove(clearedShellID)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("does not retain removed running shells in exit order", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withSession(tmp.path, () =>
          Effect.gen(function* () {
            const shell = yield* Shell.Service
            yield* Effect.forEach(Array.from({ length: 26 }), () =>
              Effect.gen(function* () {
                const info = yield* shell.create({ command: idleCommand, timeout: 0 })
                yield* shell.remove(info.id)
                expect((yield* shell.result(info)).capture).toBeUndefined()
                yield* Effect.sleep(Duration.millis(10))
              }),
            )

            const info = yield* shell.create({ command: helloCommand, timeout: 0 })
            const settled = yield* shell.wait(info.id).pipe(Effect.timeoutOption(Duration.seconds(2)))
            expect(settled._tag).toBe("Some")
            expect(yield* shell.result(info)).toMatchObject({
              info: { status: "exited", exit: 0 },
              capture: { output: expect.stringContaining("hello"), truncated: false },
            })
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  if (!isWindows) {
    it.live("settles a shell terminated by an external signal", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const shell = yield* Shell.Service
              const settled = yield* executeTool(
                registry,
                call({ command: idleCommand, background: true }, "call-external-signal"),
              )
              const shellID = settled.metadata?.shellID
              expect(typeof shellID).toBe("string")
              if (typeof shellID !== "string") return
              const id = ShellSchema.ID.make(shellID)
              const info = yield* shell.get(id)
              expect(typeof info.pid).toBe("number")
              if (info.pid === undefined) return

              process.kill(-info.pid, "SIGTERM")
              const result = yield* shell.wait(id).pipe(Effect.timeoutOption(Duration.seconds(1)))
              expect(result._tag).toBe("Some")
              if (result._tag === "Some") expect(result.value.status).toBe("exited")
              expect((yield* shell.list()).map((item) => item.id)).not.toContain(id)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    )
  }
})
