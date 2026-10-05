import type { ExternalSession } from "@ocpp/schema/external-session"
import type { ExternalAgentDriver } from "./driver.js"

export async function available(_provider: ExternalSession.Provider) {
  return false
}
export async function models(_provider: ExternalSession.Provider) {
  return []
}
export async function driver(_provider: ExternalSession.Provider): Promise<ExternalAgentDriver.Driver> {
  throw new Error("External agent SDKs require a local Node or Bun runtime")
}
