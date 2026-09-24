export * as CodexHistory from "./codex-history.node.js"

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { createHash } from "node:crypto"
import { Schema } from "effect"

const Message = Schema.Struct({
  id: Schema.optionalKey(Schema.Number),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})
const Thread = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.String,
    historyMode: Schema.Literals(["legacy", "paginated"]),
    turns: Schema.Array(Schema.Json),
  }),
})
const Page = Schema.Struct({ data: Schema.Array(Schema.Json), nextCursor: Schema.NullOr(Schema.String) })

/** Load the exact persisted thread without prompting, then read its history through the vendor API. */
export async function read(id: string, signal: AbortSignal): Promise<string | undefined> {
  const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"], signal, timeout: 30_000 })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  const state = { sequence: 0 }
  const fail = (error: unknown) => {
    for (const value of pending.values()) value.reject(error)
    pending.clear()
  }
  child.once("error", fail)
  child.once("exit", () => fail(new Error("Codex history process closed")))
  lines.on("line", (line) => {
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Message))(line)
    if (decoded._tag === "None" || decoded.value.id === undefined) return
    const item = pending.get(decoded.value.id)
    pending.delete(decoded.value.id)
    if (decoded.value.error) {
      item?.reject(decoded.value.error)
      return
    }
    item?.resolve(decoded.value.result)
  })
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = state.sequence++
      pending.set(id, { resolve, reject })
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n")
    })
  try {
    await request("initialize", {
      clientInfo: { name: "opencode-external-history", version: "1" },
      capabilities: { experimentalApi: true },
    })
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n")
    return await inspect(id, request)
  } finally {
    lines.close()
    child.kill()
  }
}

export async function inspect(
  id: string,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<string | undefined> {
  const result = await request("thread/resume", {
    threadId: id,
    excludeTurns: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    config: { sandbox_workspace_write: { network_access: false } },
  })
    .catch((error: unknown) => {
      // A fresh app-server reports unloaded IDs this way. A history read distinguishes a stored rollout from a missing session.
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        error.message === "thread not loaded: " + id
      )
        return request("thread/read", { threadId: id, includeTurns: true })
      throw error
    })
    .catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string" &&
        (error.message === "thread not found" || error.message.startsWith("no rollout found for thread id " + id))
      )
        return undefined
      throw error
    })
  if (result === undefined) return undefined
  const thread = Schema.decodeUnknownSync(Thread)(result)
  const hash = createHash("sha256")
  if (thread.thread.historyMode !== "paginated") {
    const full = Schema.decodeUnknownSync(Thread)(await request("thread/read", { threadId: id, includeTurns: true }))
    hash.update(JSON.stringify(full.thread.turns))
    return hash.digest("hex")
  }
  const page = { cursor: null as string | null }
  do {
    const result = Schema.decodeUnknownSync(Page)(
      await request("thread/turns/list", {
        threadId: id,
        cursor: page.cursor,
        limit: 100,
        sortDirection: "asc",
        itemsView: "full",
      }),
    )
    for (const item of result.data) hash.update(JSON.stringify(item))
    page.cursor = result.nextCursor
  } while (page.cursor !== null)
  return hash.digest("hex")
}
