import type { EventApi } from "@ocpp/client/effect/api"

export interface EventDomain extends Pick<EventApi<unknown>, "subscribe"> {}
