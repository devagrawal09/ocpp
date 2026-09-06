#!/usr/bin/env bun

import { mkdir } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

const args = Bun.argv.slice(2)
const once = args.includes("--once")
const directory = resolve(args.find((arg) => !arg.startsWith("-")) ?? process.cwd())
const repository = Bun.spawnSync(
  ["git", "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
  { cwd: directory, stdout: "pipe", stderr: "inherit" },
)
if (repository.exitCode !== 0) process.exit(repository.exitCode)

const [root, common] = repository.stdout.toString().trim().split("\n")
const worktrees = join(dirname(root), ".repo-agent-worktrees", basename(root))
const lock = join(common, "repo-agent.lock")
const interval = Number(process.env.REPO_AGENT_INTERVAL_SECONDS ?? 300)
if (!Number.isFinite(interval) || interval < 1) throw new Error("Interval must be a positive number")

await mkdir(worktrees, { recursive: true })
if (Bun.spawnSync(["mkdir", lock]).exitCode !== 0) throw new Error(`Another repo-agent owns ${lock}`)

process.on("exit", () => Bun.spawnSync(["rmdir", lock]))
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit())

const prompt = `Act as the Haiku repository task supervisor for ${root}.

Never edit, stage, commit, stash, reset, clean, switch, or push the developer worktree at ${root}. There is no auto-commit behavior. The user explicitly authorizes routine creation of task worktrees and branches, task-branch pushes, tests, and PR creation or updates; perform those actions without asking for confirmation. Only inspect the branch currently checked out at ${root} for new tasks. Treat unambiguous plain-English requests in its committed and pushed human changes as delegated tasks; ignore TODOs, examples, quotations, generated files, vendored files, and uncertain cases.

Use Git worktrees below ${worktrees}. Treat worktrees, branches, commits, and pull requests as durable task state; model sessions are disposable. First inspect existing task worktrees, open PRs, review comments, and CI, and continue actionable existing work. Audit existing task PR metadata and correct it when it violates this contract. Then inspect recent human commits for clear tasks and semantically deduplicate them against existing work. Start at most one new task per run from its exact origin commit and target branch. Handle simple tasks yourself. Delegate complex implementation to the opus-worker agent after creating its task worktree, then verify its result yourself. Work, test, remove the triggering instruction or placeholder, and commit only in the task worktree. Delete a dedicated instruction file instead of leaving it empty. Every task must produce a concrete code or repository artifact. Push only task branches and never merge a PR.

Immediately before publishing, fetch and semantically reconcile with the latest target branch. If the task remains current, rebase or adapt, validate, and open or update a normal PR. If target changes completed, contradicted, or superseded it, push the result and open or update a draft PR labeled obsolete with a short explanation of what changed and whether anything remains useful. Every PR body must record the original instruction, origin SHA, and target branch. Continue actionable PR feedback and CI failures in the same worktree. Stay quiet when no action is needed.`

async function run() {
  console.log(`[repo-agent] ${new Date().toISOString()} checking ${root}`)
  const branch = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: root, stdout: "pipe" })
    .stdout.toString()
    .trim()
  if (!branch) throw new Error("The developer worktree must be on a branch")
  const runPrompt = `${prompt}\n\nFor this run, the mandatory target and PR base branch is ${branch}. Never substitute the repository default branch. Verify this before finishing.`
  const claude = Bun.spawn(
    [
      "claude",
      "--print",
      "--model",
      "haiku",
      "--permission-mode",
      "auto",
      "--no-session-persistence",
      "--allowed-tools",
      "Bash,Read,Edit,Write,Glob,Grep,Task",
      "--add-dir",
      worktrees,
      "--agents",
      JSON.stringify({
        "opus-worker": {
          description: "Implement complex repository tasks in an assigned worktree",
          prompt: "You are the Opus implementation worker. Work only in the task worktree assigned by the supervisor. Follow repository instructions, implement and test the requested task, and report the exact changes and validation. Do not publish or merge pull requests.",
          tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
          model: "opus",
        },
      }),
      runPrompt,
    ],
    { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  )
  const code = await claude.exited
  if (code !== 0) console.error(`[repo-agent] Claude exited with status ${code}`)
}

async function loop(): Promise<void> {
  await run()
  await Bun.sleep(interval * 1_000)
  return loop()
}

if (once) await run()
else await loop()
