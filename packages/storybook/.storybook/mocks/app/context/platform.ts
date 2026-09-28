import type { Platform } from "../../../../../app/src/runtime/platform/platform"

const value: Platform = {
  openExternal() {},
  restart: async () => {},
  notify: async () => {},
}

export function usePlatform() {
  return value
}
