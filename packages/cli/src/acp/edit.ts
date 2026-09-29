import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { isAbsolute, resolve } from "node:path"
import { stringValue, toToolKind, type ToolInput } from "./tool"

/** Sends the client the files a completed edit changed, when it advertised writeTextFile. */
export async function syncEditedFiles(input: {
  readonly connection: Partial<Pick<AgentSideConnection, "writeTextFile">>
  readonly writeTextFile: boolean
  readonly sessionID: string
  readonly cwd: string
  readonly toolName: string
  readonly toolInput: ToolInput
  readonly metadata: Readonly<Record<string, unknown>>
}) {
  if (!input.writeTextFile || !input.connection.writeTextFile || toToolKind(input.toolName) !== "edit") return
  const files = Array.isArray(input.metadata.files)
    ? input.metadata.files.flatMap((file): string[] => {
        if (!file || typeof file !== "object") return []
        const path = Reflect.get(file, "file")
        return typeof path === "string" ? [path] : []
      })
    : []
  const path = filePath(input.toolInput)
  const paths = [...new Set([...files, ...(path ? [path] : [])])]
  await Promise.all(
    paths.map(async (path) => {
      const target = resolvePath(path, input.cwd)
      const file = Bun.file(target)
      if (!(await file.exists())) return
      await input.connection.writeTextFile?.({ sessionId: input.sessionID, path: target, content: await file.text() })
    }),
  )
}

function filePath(input: ToolInput) {
  return stringValue(input.path) ?? stringValue(input.filePath) ?? stringValue(input.filepath)
}

function resolvePath(path: string, cwd: string) {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

export * as ACPEdit from "./edit"
