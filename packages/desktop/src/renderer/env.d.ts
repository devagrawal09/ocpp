import type { ElectronNative } from "../preload/types"

declare global {
  interface Window {
    electron: ElectronNative
    __OCPP__?: {
      deepLinks?: string[]
    }
  }
}
