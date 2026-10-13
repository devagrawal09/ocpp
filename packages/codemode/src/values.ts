import type { Fiber } from "effect"

export class CodeModePromise {
  constructor(readonly fiber: Fiber.Fiber<unknown, unknown>) {}
}

/**
 * A call to a concurrent tool, started when the program reached it and running on its own while the
 * program continues. `run.wait()` returns the call's result or throws its error. A run is opaque, is not
 * data, cannot be saved, and belongs to the execution that started it.
 */
export class ToolRun {
  constructor(
    /** The tool's canonical path, such as `subagent`. */
    readonly tool: string,
    readonly fiber: Fiber.Fiber<unknown, unknown>,
  ) {}
}
