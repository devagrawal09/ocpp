export * as Project from "./project.js"

import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm"
import path from "path"
import { AbsolutePath } from "./schema.js"
import { Bus } from "./bus.js"
import { Database } from "./database/database.js"
import { ProjectFact } from "@ocpp/schema/project-fact"
import { Worktree } from "@ocpp/schema/worktree"
import { FSUtil } from "@ocpp/util/fs-util"
import { Git } from "./git.js"
import { AppProcess } from "@ocpp/util/process"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Hash } from "@ocpp/util/hash"
import { ProjectMarkers } from "./project/markers.js"
import { ProjectSchema } from "./project/schema.js"
import { ProjectProjector } from "./project/projector.js"
import { ProjectTable } from "./project/sql.js"
import { WorktreeTable } from "./worktree/sql.js"
import { KeyedMutex } from "./effect/keyed-mutex.js"

export const ID = ProjectSchema.ID
export type ID = ProjectSchema.ID

export const Vcs = ProjectSchema.Vcs
export type Vcs = ProjectSchema.Vcs

export const Current = ProjectSchema.Current
export type Current = ProjectSchema.Current

export const Info = ProjectSchema.Info
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const UpdateInput = ProjectSchema.UpdateInput
export type UpdateInput = ProjectSchema.UpdateInput

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Project.NotFoundError", {
  projectID: ID,
}) {}

export interface Resolved {
  readonly previous?: ID
  readonly id: ID
  readonly directory: AbsolutePath
  // This checkout's main directory; the stored project canonical may be another clone.
  readonly canonical: AbsolutePath
  readonly vcs?: Vcs
  readonly vcsBackend?: string
}

// Keep this filesystem-only; path resolution uses it and should not execute VCS commands.
export const root = Effect.fn("Project.root")(function* (
  fs: FSUtil.Interface,
  input: AbsolutePath,
  markers: readonly string[] = [".git", ".hg"],
) {
  return yield* fs.up({ targets: [...markers], start: input, mode: "first" }).pipe(
    Effect.map((matches) => (matches[0] ? AbsolutePath.make(path.dirname(matches[0])) : undefined)),
    Effect.orElseSucceed(() => undefined),
  )
})

export interface Interface {
  readonly list: () => Effect.Effect<ReadonlyArray<Info>>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  /** Resolves and persists the owning Project. */
  readonly resolve: (input: AbsolutePath, options?: { readonly discovery?: boolean }) => Effect.Effect<Resolved>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/Project") {}

function fromRow(row: typeof ProjectTable.$inferSelect): Info {
  const icon =
    row.icon_url || row.icon_url_override || row.icon_color
      ? {
          url: row.icon_url ?? undefined,
          override: row.icon_url_override ?? undefined,
          color: row.icon_color ?? undefined,
        }
      : undefined
  return {
    id: row.id,
    canonical: row.worktree,
    vcs: row.vcs ?? undefined,
    name: row.name ?? undefined,
    icon,
    commands: row.commands ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      initialized: row.time_initialized ?? undefined,
    },
    sandboxes: row.sandboxes,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const markers = yield* ProjectMarkers.Service
    const proc = yield* AppProcess.Service
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db

    const announcing = new Set<string>()
    // Facts about one project are decided one at a time, so concurrent resolves record each change once.
    const locks = KeyedMutex.makeUnsafe<ID>()
    const record = Effect.fnUntraced(function* (project: Resolved) {
      const previous = yield* db
        .select({ canonical: ProjectTable.worktree, vcs: ProjectTable.vcs })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, project.id))
        .get()
        .pipe(Effect.orDie)
      const vcs = project.vcs?.type
      if (!previous)
        return yield* bus.publish(ProjectFact.Created, {
          projectID: project.id,
          canonical: project.canonical,
          ...(vcs === undefined ? {} : { vcs }),
        })
      if ((previous.vcs ?? undefined) !== vcs)
        yield* bus.publish(ProjectFact.VcsChanged, { projectID: project.id, ...(vcs === undefined ? {} : { vcs }) })
      // Clones share a project ID; only replace a canonical directory that is gone.
      if (
        previous.canonical !== project.canonical &&
        !(yield* fs.exists(previous.canonical).pipe(Effect.orElseSucceed(() => true)))
      ) {
        yield* bus.publish(ProjectFact.Relocated, { projectID: project.id, canonical: project.canonical })
        const row = yield* db
          .select()
          .from(ProjectTable)
          .where(eq(ProjectTable.id, project.id))
          .get()
          .pipe(Effect.orDie)
        if (row) yield* bus.publish(ProjectSchema.Event.Updated, fromRow(row))
      }
    })
    const persist = Effect.fnUntraced(function* (project: Resolved) {
      yield* locks.withLock(project.id)(record(project))
      if (!project.vcs) return project
      const directories: Array<{ projectID: ID; directory: AbsolutePath; strategy?: string }> = [
        { projectID: project.id, directory: project.canonical },
      ]
      if (project.directory !== project.canonical)
        directories.push({
          projectID: project.id,
          directory: project.directory,
          strategy: project.vcs.type === "git" ? "git" : undefined,
        })
      // A missing directory row means this directory's resolution is a new durable
      // fact. The row insert commits atomically with the event, so a crash between
      // checks retries on the next resolve instead of stranding the announcement.
      // The in-flight set keeps concurrent resolves from publishing the same fact
      // twice.
      for (const item of directories) {
        const key = item.projectID + "\u0000" + item.directory
        if (announcing.has(key)) continue
        announcing.add(key)
        yield* Effect.gen(function* () {
          const stored = yield* db
            .select({ directory: WorktreeTable.directory })
            .from(WorktreeTable)
            .where(and(eq(WorktreeTable.project_id, item.projectID), eq(WorktreeTable.directory, item.directory)))
            .get()
            .pipe(Effect.orDie)
          if (stored) return
          const directory = AbsolutePath.make(yield* fs.resolve(item.directory))
          const markerless = yield* db
            .select({ id: ProjectTable.id, directory: ProjectTable.worktree })
            .from(ProjectTable)
            .where(
              and(
                isNull(ProjectTable.vcs),
                gte(ProjectTable.worktree, directory),
                lte(ProjectTable.worktree, AbsolutePath.make(directory + "\uffff")),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          const adopted = yield* Effect.filter(markerless, (candidate) =>
            Effect.gen(function* () {
              if (candidate.id === item.projectID) return false
              if (!FSUtil.contains(directory, candidate.directory)) return false
              const found = yield* fs
                .up({ targets: [...markers.targets()], start: candidate.directory, stop: directory, mode: "first" })
                .pipe(Effect.orElseSucceed(() => []))
              if (!found[0]) return false
              return (yield* fs.resolve(path.dirname(found[0]))) === directory
            }),
          )
          // The directory's row is stored by the fact recorded with its resolution.
          yield* bus.publishAll([
            [
              Worktree.Event.Resolved,
              {
                projectID: item.projectID,
                directory: item.directory,
                previous: project.previous ?? ID.global,
                ...(adopted.length ? { adopted: adopted.map((candidate) => candidate.id) } : {}),
              },
            ],
            [
              ProjectFact.WorktreeRecorded,
              {
                projectID: item.projectID,
                directory: item.directory,
                ...(item.strategy === undefined ? {} : { strategy: item.strategy }),
              },
            ],
          ])
        }).pipe(Effect.ensuring(Effect.sync(() => announcing.delete(key))))
      }
      return project
    })

    const list = Effect.fn("Project.list")(function* () {
      const rows = yield* db
        .select()
        .from(ProjectTable)
        .orderBy(desc(ProjectTable.time_updated), asc(ProjectTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const find = (projectID: ID) =>
      db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get().pipe(Effect.orDie)

    const update = Effect.fn("Project.update")(function* (input: UpdateInput) {
      if (!(yield* find(input.projectID))) return yield* new NotFoundError({ projectID: input.projectID })
      yield* bus.publish(ProjectFact.Edited, input)
      const row = yield* find(input.projectID)
      if (!row) return yield* new NotFoundError({ projectID: input.projectID })
      const project = fromRow(row)
      yield* bus.publish(ProjectSchema.Event.Updated, project)
      return project
    })

    const cached = Effect.fnUntraced(function* (dir: string) {
      return yield* fs.readFileString(path.join(dir, "ocpp")).pipe(
        Effect.map((value) => value.trim()),
        Effect.map((value) => (value ? ID.make(value) : undefined)),
        Effect.orElseSucceed(() => undefined),
      )
    })

    const remote = Effect.fnUntraced(function* (repo: Git.Repository) {
      const origin = yield* git.remote.get(repo)
      if (!origin) return undefined
      const normalized = url(origin)
      if (!normalized) return undefined
      return ID.make(Hash.fast(`git-remote:${normalized}`))
    })

    function url(input: string) {
      const value = input.trim()
      if (!value) return undefined

      const parsed = URL.parse(value)
      if (parsed) {
        if (parsed.protocol === "file:") return undefined
        return parts(parsed.hostname, parsed.pathname)
      }
      const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
      if (scp) return parts(scp[2], scp[3])
      return undefined
    }

    function parts(host: string, name: string) {
      const pathname = name
        .replace(/^\/+/, "")
        .replace(/\.git\/?$/, "")
        .replace(/\/+$/, "")
      if (!host || !pathname) return undefined
      return `${host.toLowerCase()}/${pathname}`
    }

    const rootCommit = Effect.fnUntraced(function* (repo: Git.Repository) {
      const root = (yield* git.history.rootCommits(repo))[0]
      return root ? ID.make(root) : undefined
    })

    // Mercurial identity uses the cached ID or the first root changeset; remote-derived
    // identity (the git `remote()` path) is a follow-up.
    const hgRoot = Effect.fnUntraced(function* (worktree: AbsolutePath) {
      const result = yield* proc
        .run(
          ChildProcess.make("hg", ["log", "-r", "roots(all())", "-T", "{node}\n"], {
            cwd: worktree,
            env: { HGPLAIN: "1" },
            extendEnv: true,
            stdin: "ignore",
          }),
        )
        .pipe(Effect.orElseSucceed(() => undefined))
      if (!result || result.exitCode !== 0) return undefined
      const node = result.stdout
        .toString("utf8")
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
        .toSorted()[0]
      return node ? ID.make(node) : undefined
    })

    const hgDiscover = Effect.fnUntraced(function* (dotHg: AbsolutePath) {
      const worktree = AbsolutePath.make(path.dirname(dotHg))
      const store = AbsolutePath.make(dotHg)
      const previous = yield* cached(store)
      const id = previous ?? (yield* hgRoot(worktree))
      return {
        previous,
        id: id ?? ID.global,
        directory: worktree,
        vcs: { type: "hg" as const, store },
      }
    })

    const resolve = Effect.fn("Project.resolve")(function* (
      input: AbsolutePath,
      options?: { readonly discovery?: boolean },
    ) {
      const directory = AbsolutePath.make(yield* fs.resolve(input))
      const marker = yield* markers.discover(directory, options)
      const native = yield* fs.up({ targets: [".git", ".hg"], start: directory, mode: "first" }).pipe(
        Effect.map((matches) => matches[0]),
        Effect.orElseSucceed(() => undefined),
      )
      const repo =
        native && path.basename(native) === ".git"
          ? yield* git.repo.discover(AbsolutePath.make(path.dirname(native)))
          : undefined
      if (repo && (!marker || FSUtil.contains(marker.directory, repo.worktree))) {
        const previous = yield* cached(repo.commonDirectory)
        const id = (yield* remote(repo)) ?? previous ?? (yield* rootCommit(repo))
        const canonical =
          repo.gitDirectory === repo.commonDirectory
            ? repo.worktree
            : yield* git.worktree.list(repo).pipe(
                Effect.map((items) => items.find((item) => item.kind === "main")?.directory ?? repo.worktree),
                Effect.orElseSucceed(() => repo.worktree),
              )
        return yield* persist({
          previous,
          id: id ?? ID.global,
          directory: repo.worktree,
          canonical,
          vcs: { type: "git" as const, store: repo.commonDirectory },
          ...(marker?.directory === repo.worktree && marker.type !== "git" ? { vcsBackend: marker.type } : {}),
        })
      }

      const hg = native && path.basename(native) === ".hg" ? yield* hgDiscover(AbsolutePath.make(native)) : undefined
      if (hg && (!marker || FSUtil.contains(marker.directory, hg.directory))) {
        return yield* persist({
          ...hg,
          canonical: hg.directory,
          ...(marker?.directory === hg.directory && marker.type !== "hg" ? { vcsBackend: marker.type } : {}),
        })
      }

      if (marker) {
        const previous = yield* cached(marker.marker)
        return yield* persist({
          previous,
          id: previous ?? ID.make(Hash.fast(`vcs-repository:${marker.type}:${marker.marker}`)),
          directory: marker.directory,
          canonical: marker.directory,
          vcs: { type: marker.type, store: marker.marker },
        })
      }

      return yield* persist({
        id: ID.make(Hash.fast(`directory:${directory}`)),
        directory,
        canonical: directory,
        vcs: undefined,
      })
    })

    return Service.of({ list, update, resolve })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Bus.node, Database.node, ProjectProjector.node, FSUtil.node, Git.node, ProjectMarkers.node, AppProcess.node],
})
