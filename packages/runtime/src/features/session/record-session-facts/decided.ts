// The facts a Command of their own decides, by that Command: recording one as
// a host fact would skip its decision, so recordSessionFacts refuses it.
export const decided = {
  "session-created": "createSession",
  "session-imported": "createSession",
  "session-forked": "forkSession",
  "session-moved": "moveSession",
  "session-deleted": "deleteSession",
  "session-revert-staged": "stageRevert",
  "session-revert-cleared": "clearRevert",
  "session-revert-committed": "commitRevert",
} as const

export const refusal = (type: string) =>
  type in decided ? `${type} is recorded by ${decided[type as keyof typeof decided]}` : undefined
