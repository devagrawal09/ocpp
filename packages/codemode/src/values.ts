import type { Fiber } from "effect"

export class CodeModePromise {
  constructor(readonly fiber: Fiber.Fiber<unknown, unknown>) {}
}
