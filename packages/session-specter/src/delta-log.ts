export type LogRecord = {
  readonly version: number
  readonly events: readonly { readonly order: number; readonly type: string; readonly payload: unknown }[]
}

/**
 * Reads complete commit lines of a JSONL Event Log (a step delta log or a Session log) from a
 * byte offset. The JSONL Event Log adapter is not a safe reader: opening it truncates an
 * unterminated last line, which is the writer's in-flight append. Tail consumers read bytes,
 * stop at the last newline, and resume from the returned offset.
 */
export async function readLog(path: string, offset: number) {
  const file = Bun.file(path)
  if (!(await file.exists())) return { records: [] as LogRecord[], offset }
  const bytes = await file.slice(offset).bytes()
  const complete = bytes.lastIndexOf(0x0a) + 1
  return {
    records: new TextDecoder()
      .decode(bytes.subarray(0, complete))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogRecord),
    offset: offset + complete,
  }
}

/** Folds delta records into the visible text of the latest attempt. */
export function deltaText(records: readonly LogRecord[]) {
  return records
    .flatMap((record) => record.events)
    .reduce((text, event) => {
      if (event.type === "attempt-started") return ""
      if (event.type !== "text-delta" || !isDelta(event.payload)) return text
      return text + event.payload.delta
    }, "")
}

function isDelta(payload: unknown): payload is { delta: string } {
  return typeof payload === "object" && payload !== null && "delta" in payload && typeof payload.delta === "string"
}
