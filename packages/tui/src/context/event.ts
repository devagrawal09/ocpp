import type { OcppEvent } from "@ocpp/client"
import { useClient } from "./client"

type EventMetadata = {
  directory: string | undefined
  workspace: string | undefined
}

export function useEvent() {
  const client = useClient()

  function subscribe(handler: (event: OcppEvent, metadata: EventMetadata) => void) {
    return client.event.listen(({ details }) => {
      if (details.type === "server.connected") return
      handler(details, { directory: details.location?.directory, workspace: details.location?.workspaceID })
    })
  }

  function on<T extends OcppEvent["type"]>(
    type: T,
    handler: (event: Extract<OcppEvent, { type: T }>, metadata: EventMetadata) => void,
  ) {
    return client.event.on(type, (event) => {
      handler(event, { directory: event.location?.directory, workspace: event.location?.workspaceID })
    })
  }

  return {
    subscribe,
    on,
  }
}
