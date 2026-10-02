import type { PromptFileAttachment } from "@ocpp/client/promise"

export type SessionUserComment = {
  path: string
  comment: string
  selection?: {
    startLine: number
    endLine: number
  }
}

export type SessionUserActions = {
  openAttachment?: (file: PromptFileAttachment) => void
  /** Opens a workspace file, such as one a displayed result names. */
  openFile?: (path: string) => void
  revert?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
}
