export * as CodeModeLimits from "./limits.js"

export const activation = {
  timeoutMs: 120_000,
  maxToolCalls: 100,
  maxResultBytes: 1024 * 1024,
  maxCaptureBytes: 256 * 1024,
  maxLogBytes: 256 * 1024,
  projectionBytes: 16 * 1024,
  resultPageBytes: 16 * 1024,
} as const
