import type { SessionMessageAssistantTool } from "@ocpp/client/promise"

type ToolState =
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title?: string
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }
  | {
      status: "error"
      input: Record<string, unknown>
      error: string
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }

/** The tool part shape `run --format json` emits, kept stable for existing consumers. */
export type ToolPart = {
  partID: string
  sessionID: string
  messageID: string
  type?: "tool"
  id: string
  tool: string
  state: ToolState
}

export function toolOutputText(content: ReadonlyArray<{ type: string; text?: string }> | undefined) {
  if (!content) return ""
  return content.flatMap((item) => (item.type === "text" && item.text ? [item.text] : [])).join("\n")
}

export function nonEmptyToolContent<T>(content: ReadonlyArray<T> | undefined): [T, ...T[]] | undefined {
  if (!content) return undefined
  const [first, ...rest] = content
  return first === undefined ? undefined : [first, ...rest]
}

/** The model only calls `execute`, so a tool part is normally a program: show its source as a block. */
export function toolDisplay(part: SessionMessageAssistantTool) {
  const input = typeof part.state.input === "object" && part.state.input !== null ? part.state.input : {}
  const code = "code" in input && typeof input.code === "string" ? input.code : undefined
  if (part.name === "execute" && code !== undefined) return { title: "execute", body: code }
  return { title: Object.keys(input).length > 0 ? `${part.name} ${JSON.stringify(input)}` : part.name }
}
