export * as CodeModeLimits from "./limits.js"

/** Host-owned safety limits. They are fixed: a program cannot raise or lower them. */
export const limits = {
  maxToolCalls: 100,
  maxDeclarationBytes: 256 * 1024,
  maxCaptureBytes: 256 * 1024,
  maxLogBytes: 64 * 1024,
  maxPreviewBytes: 4 * 1024,
  maxSummaryBytes: 8 * 1024,
  /**
   * Notebook names are append-only, so a Session's notebook only ever grows. These bound one
   * execution and the Session total. The per-execution limit is checked at admission, before any
   * tool runs; the totals are rechecked inside the commit transaction because concurrent
   * executions can each pass admission and only collide when they save.
   */
  maxDeclarationsPerExecution: 64,
  maxNotebookValues: 512,
  maxNotebookBytes: 8 * 1024 * 1024,
} as const
