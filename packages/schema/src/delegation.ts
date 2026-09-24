export * as Delegation from "./delegation.js"

/** Tools whose progress points to a normal child Session. */
export function isTool(name: string) {
  return name === "subagent" || name === "claude" || name === "codex" || name === "pi"
}
