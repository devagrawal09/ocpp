import { registerCustomTheme } from "@pierre/diffs"
import { OcppTheme } from "./marked-theme"

let registered = false

export function registerOcppTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("OC++", () => Promise.resolve(OcppTheme))
}
