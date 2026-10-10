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
  "session-renamed": "renameSession",
  "session-agent-selected": "selectAgent",
  "session-model-selected": "selectModel",
  "session-tools-selected": "selectTools",
  "session-viewed": "viewSession",
  "session-displayed": "displayResult",
  "session-usage-recorded": "recordUsage",
  "session-message-content-updated": "editMessage",
  "session-skill-activated": "activateSkill",
  "session-synthetic": "appendSynthetic",
  "session-instructions-updated": "updateInstructions",
  "session-instruction-blobs-stored": "updateInstructions",
  "session-instruction-entry-set": "setInstructionEntry",
  "session-instruction-entry-removed": "removeInstructionEntry",
} as const

export const refusal = (type: string) =>
  type in decided ? `${type} is recorded by ${decided[type as keyof typeof decided]}` : undefined
