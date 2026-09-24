import type { EventApi } from "@ocpp/client/promise/api"

export interface EventDomain extends Pick<EventApi, "subscribe"> {}
