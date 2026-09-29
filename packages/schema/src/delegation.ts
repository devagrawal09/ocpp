export * as Delegation from "./delegation.js"

/**
 * Tools whose progress points to a normal child Session. `claude`, `codex` and `pi` are retired tools (vendor
 * children now come from `subagent` with a driver), kept so older sessions still render their children.
 */
export function isTool(name: string) {
  return name === "subagent" || name === "claude" || name === "codex" || name === "pi"
}
