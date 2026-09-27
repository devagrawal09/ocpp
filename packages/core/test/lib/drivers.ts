import { Config } from "@ocpp/core/config"
import { ExternalAgentDrivers } from "@ocpp/core/external-agent/drivers"
import { makeLocationNode } from "@ocpp/util/effect/app-node"

/** Vendor drivers on a scripted platform, so tests never probe or launch an installed vendor CLI. */
export const vendorDrivers = (platform: ExternalAgentDrivers.Platform) =>
  makeLocationNode({
    service: ExternalAgentDrivers.Service,
    layer: ExternalAgentDrivers.layer(platform),
    deps: [Config.node],
  })

export const noVendorDrivers = vendorDrivers({
  available: async () => false,
  driver: async (provider) => {
    throw new Error("No vendor driver in tests: " + provider)
  },
})
