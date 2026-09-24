declare const OCPP_VERSION: string
declare const OCPP_CHANNEL: string

const version = typeof OCPP_VERSION === "string" ? OCPP_VERSION : "local"
const channel = typeof OCPP_CHANNEL === "string" ? OCPP_CHANNEL : "local"

export { version as OCPP_VERSION, channel as OCPP_CHANNEL }
export const OCPP_LOCAL = channel === "local"
