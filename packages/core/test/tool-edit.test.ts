import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Environment } from "@ocpp/core/environment/index"
import { FileMutation } from "@ocpp/core/file-mutation"
import { Formatter } from "@ocpp/core/formatter"
import { Location } from "@ocpp/core/location"
import { LocationMutation } from "@ocpp/core/location-mutation"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { Tool } from "@ocpp/core/tool"
import { EditTool } from "@ocpp/core/tool/plugin/edit"
import { transformEnvironmentFiles } from "./fixture/environment"
import { location } from "./fixture/location"
import { tmpdir, withTempDir } from "./fixture/tmpdir"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { testEffect } from "./lib/effect"
import { toolIdentity, codeModeTools, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"

const editToolNode = makeLocationNode({
  name: "test/edit-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(EditTool.Plugin)),
  deps: [Tool.node, LocationMutation.node, FileMutation.node, Environment.node, Formatter.node, Location.node],
})

const sessionID = Session.ID.make("ses_edit_tool_test")
const makeEditFixture = () => {
  const fixture: {
    writes: string[]
    reads: number
    afterRead: () => Effect.Effect<void>
    formatFile: (target: string) => Effect.Effect<boolean>
  } = {
    writes: [],
    reads: 0,
    afterRead: () => Effect.void,
    formatFile: () => Effect.succeed(false),
  }

  const formatter = Layer.mock(Formatter.Service, {
    file: (target) => fixture.formatFile(target),
  })

  return Object.assign(fixture, { formatter })
}

const withTool = <A, E, R>(
  directory: string,
  fixture: ReturnType<typeof makeEditFixture>,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R>,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Tool.node, LocationMutation.node, FileMutation.node, editToolNode]), [
        [
          Environment.node,
          transformEnvironmentFiles((files) => ({
            read: (target, range) =>
              files
                .read(target, range)
                .pipe(
                  Effect.tap(() => Effect.sync(() => fixture.reads++).pipe(Effect.andThen(() => fixture.afterRead()))),
                ),
            write: (target, content) =>
              Effect.sync(() => fixture.writes.push(target)).pipe(Effect.andThen(files.write(target, content))),
          })),
        ],
        [Location.node, activeLocation],
        [Formatter.node, fixture.formatter],
      ]),
    ),
  )
}

const call = (input: typeof EditTool.Input.Type, id = "call-edit") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "edit", input },
})

const it = testEffect(Layer.empty)

describe("EditTool", () => {
  it.live("registers and replaces relative exact text through FileMutation once", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "hello.txt")
      return Effect.promise(() => fs.writeFile(target, "before\nrest\n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.gen(function* () {
              expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["execute"])
              expect(yield* codeModeTools(registry)).toEqual(["edit"])
              expect(yield* toolDefinitions(registry, { paths: ["read"] })).toEqual([])
              expect(yield* codeModeTools(registry, { paths: ["read"] })).toEqual([])
              const settled = yield* executeTool(
                registry,
                call({ path: "hello.txt", oldString: "before", newString: "after" }),
              )
              expect(settled.status).toBe("completed")
              if (settled.status !== "completed") return
              expect(settled.content).toEqual([
                {
                  type: "text",
                  text: "Edited hello.txt (1 replacement)",
                },
              ])
              // Compact UI metadata carries the file diffs the web app renders.
              expect(settled.metadata).toMatchObject({
                files: [{ file: "hello.txt", status: "modified", additions: 1, deletions: 1 }],
              })
              expect(settled.output).toEqual({
                replacements: 1,
                files: [
                  {
                    file: "hello.txt",
                    status: "modified",
                    additions: 1,
                    deletions: 1,
                    patch: expect.stringContaining("-before\n+after"),
                  },
                ],
              })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\nrest\n")
              expect(edit.writes).toEqual([yield* Effect.promise(() => fs.realpath(target))])
            }),
          ),
        ),
      )
    }),
  )

  it.live("returns the diff for final formatted content", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "formatted.txt")
      edit.formatFile = (file) =>
        Effect.promise(async () => {
          await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("after", "AFTER"))
          return true
        })
      return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.gen(function* () {
              const settled = yield* executeTool(
                registry,
                call({ path: "formatted.txt", oldString: "before", newString: "after" }),
              )
              expect(settled.status).toBe("completed")
              if (settled.status !== "completed") return
              expect(settled.output.files[0]?.patch).toContain("-before\n+AFTER")
              expect(settled.metadata?.files?.[0]?.patch).toContain("-before\n+AFTER")
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("AFTER\n")
            }),
          ),
        ),
      )
    }),
  )

  it.live("accepts an absolute file path inside the active Location", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "absolute.txt")
      return Effect.promise(() => fs.writeFile(target, "before")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            executeTool(registry, call({ path: target, oldString: "before", newString: "after" })),
          ),
        ),
        Effect.andThen((result) =>
          Effect.gen(function* () {
            expect(result.status).toBe("completed")
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after")
          }),
        ),
      )
    }),
  )

  it.live("edits an external symlink target through its in-location link", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        const edit = makeEditFixture()
        if (process.platform === "win32") return Effect.void
        const target = path.join(outside.path, "external.txt")
        const link = path.join(active.path, "link.txt")
        return Effect.promise(async () => {
          await fs.writeFile(target, "before")
          await fs.symlink(target, link)
        }).pipe(
          Effect.andThen(
            withTool(active.path, edit, (registry) =>
              executeTool(registry, call({ path: "link.txt", oldString: "before", newString: "after" })),
            ),
          ),
          Effect.andThen((result) =>
            Effect.sync(() => {
              expect(result.status).toBe("completed")
            }),
          ),
          Effect.andThen(Effect.promise(() => fs.readFile(target, "utf8"))),
          Effect.tap((content) => Effect.sync(() => expect(content).toBe("after"))),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("edits an explicit external absolute path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        const edit = makeEditFixture()
        const target = path.join(outside.path, "external.txt")
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(active.path, edit, (registry) =>
              executeTool(registry, call({ path: target, oldString: "before", newString: "after" })),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result.status).toBe("completed")
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after")
              expect(edit.writes).toHaveLength(1)
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("rejects no-op, empty, missing, and ambiguous exact replacements", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "matches.txt")
      return Effect.promise(() => fs.writeFile(target, "same same")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.gen(function* () {
              expect(
                yield* executeTool(registry, call({ path: "matches.txt", oldString: "same", newString: "same" })),
              ).toEqual({
                status: "error",
                error: {
                  type: "tool.execution",
                  message: "No changes to apply: oldString and newString are identical.",
                },
              })
              expect(
                yield* executeTool(registry, call({ path: "matches.txt", oldString: "", newString: "after" })),
              ).toEqual({
                status: "error",
                error: {
                  type: "tool.execution",
                  message: "oldString must not be empty. Use write to create or overwrite a file.",
                },
              })
              expect(
                yield* executeTool(registry, call({ path: "matches.txt", oldString: "missing", newString: "after" })),
              ).toEqual({
                status: "error",
                error: {
                  type: "tool.execution",
                  message:
                    "Could not find oldString in matches.txt. It must match exactly, including whitespace and indentation.",
                },
              })
              expect(
                yield* executeTool(registry, call({ path: "matches.txt", oldString: "same", newString: "after" })),
              ).toEqual({
                status: "error",
                error: {
                  type: "tool.execution",
                  message:
                    "Found 2 matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.",
                },
              })
              expect(edit.writes).toEqual([])
            }),
          ),
        ),
      )
    }),
  )

  it.live("returns specific missing file and directory errors", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const directory = path.join(tmp.path, "src")
      return Effect.promise(() => fs.mkdir(directory)).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.gen(function* () {
              expect(
                yield* executeTool(registry, call({ path: "missing.ts", oldString: "before", newString: "after" })),
              ).toEqual({
                status: "error",
                error: { type: "tool.execution", message: "File not found: missing.ts" },
              })
              expect(
                yield* executeTool(registry, call({ path: "src", oldString: "before", newString: "after" })),
              ).toEqual({
                status: "error",
                error: { type: "tool.execution", message: "Path is a directory, not a file: src" },
              })
              expect(edit.writes).toEqual([])
            }),
          ),
        ),
      )
    }),
  )

  it.live("replaces every exact occurrence when replaceAll is true", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "all.txt")
      return Effect.promise(() => fs.writeFile(target, "same same same")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            executeTool(registry, call({ path: "all.txt", oldString: "same", newString: "after", replaceAll: true })),
          ),
        ),
        Effect.andThen((settled) =>
          Effect.gen(function* () {
            expect(settled.status).toBe("completed")
            if (settled.status !== "completed") return
            expect(settled.output).toMatchObject({ replacements: 3 })
            expect(settled.content).toEqual([{ type: "text", text: "Edited all.txt (3 replacements)" }])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after after after")
            expect(edit.writes).toHaveLength(1)
          }),
        ),
      )
    }),
  )

  it.live("normalizes Unicode typography only after exact matching fails", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "unicode.txt")
      return Effect.promise(() =>
        fs.writeFile(target, "exact - match\ncurly “quotes”\nminus − one\nspace\u00A0here\nexact − match\n"),
      ).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.gen(function* () {
              const normalized = yield* executeTool(
                registry,
                call({
                  path: "unicode.txt",
                  oldString: 'curly "quotes"\nminus - one\nspace here',
                  newString: "normalized",
                }),
              )
              expect(normalized.status).toBe("completed")

              const exact = yield* executeTool(
                registry,
                call({ path: "unicode.txt", oldString: "exact - match", newString: "selected" }),
              )
              expect(exact.status).toBe("completed")
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(
                "selected\nnormalized\nexact − match\n",
              )
            }),
          ),
        ),
      )
    }),
  )

  it.live("ignores trailing whitespace while preserving untouched lines", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "whitespace.txt")
      return Effect.promise(() => fs.writeFile(target, "before  \nmatch  \nnext\t\nafter  \n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            executeTool(registry, call({ path: "whitespace.txt", oldString: "match\nnext", newString: "changed" })),
          ),
        ),
        Effect.tap((result) => Effect.sync(() => expect(result.status).toBe("completed"))),
        Effect.andThen(Effect.promise(() => fs.readFile(target, "utf8"))),
        Effect.tap((content) => Effect.sync(() => expect(content).toBe("before  \nchanged\nafter  \n"))),
      )
    }),
  )

  it.live("uses non-overlapping trailing-whitespace matches and preserves CRLF", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const overlap = path.join(tmp.path, "overlap.txt")
      const windows = path.join(tmp.path, "windows.txt")
      return Effect.promise(() =>
        Promise.all([fs.writeFile(overlap, "a  \na  \na  \n"), fs.writeFile(windows, "a  \r\nb\t\r\n")]),
      ).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.gen(function* () {
              const replaced = yield* executeTool(
                registry,
                call({ path: "overlap.txt", oldString: "a\na", newString: "x", replaceAll: true }),
              )
              expect(replaced).toMatchObject({ status: "completed", output: { replacements: 1 } })
              yield* executeTool(registry, call({ path: "windows.txt", oldString: "a\nb", newString: "x" }))
            }),
          ),
        ),
        Effect.andThen(Effect.promise(() => Promise.all([fs.readFile(overlap, "utf8"), fs.readFile(windows, "utf8")]))),
        Effect.tap(([overlapContent, windowsContent]) =>
          Effect.sync(() => {
            expect(overlapContent).toBe("x\na  \n")
            expect(windowsContent).toBe("x\r\n")
          }),
        ),
      )
    }),
  )

  it.live("preserves BOM and CRLF line endings", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "windows.txt")
      edit.formatFile = (file) =>
        Effect.promise(async () => {
          await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""))
          return true
        })
      return Effect.promise(() => fs.writeFile(target, "\uFEFFbefore\r\nrest\r\n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            executeTool(registry, call({ path: "windows.txt", oldString: "before\nrest", newString: "after\nrest" })),
          ),
        ),
        Effect.andThen(() => Effect.promise(() => fs.readFile(target, "utf8"))),
        Effect.tap((content) => Effect.sync(() => expect(content).toBe("\uFEFFafter\r\nrest\r\n"))),
      )
    }),
  )

  it.live("serializes concurrent edit transactions", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "concurrent.txt")
      edit.afterRead = () => (edit.reads === 1 ? Effect.sleep("50 millis") : Effect.void)
      return Effect.promise(() => fs.writeFile(target, "one\ntwo\n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.all(
              [
                executeTool(
                  registry,
                  call({ path: "concurrent.txt", oldString: "one", newString: "ONE" }, "call-edit-one"),
                ),
                executeTool(
                  registry,
                  call({ path: "concurrent.txt", oldString: "two", newString: "TWO" }, "call-edit-two"),
                ),
              ],
              { concurrency: "unbounded" },
            ),
          ),
        ),
        Effect.andThen((results) =>
          Effect.gen(function* () {
            expect(results.map((result) => result.status)).toEqual(["completed", "completed"])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("ONE\nTWO\n")
          }),
        ),
      )
    }),
  )

  it.live("applies the edit when content changes after matching", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "concurrent.txt")
      edit.afterRead = () => (edit.reads === 1 ? Effect.promise(() => fs.writeFile(target, "newer\n")) : Effect.void)
      return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            executeTool(registry, call({ path: "concurrent.txt", oldString: "before", newString: "after" })),
          ),
        ),
        Effect.andThen((result) =>
          Effect.gen(function* () {
            expect(result).toMatchObject({ status: "completed", output: { replacements: 1 } })
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\n")
            expect(edit.writes).toEqual([target])
          }),
        ),
      )
    }),
  )
})
