import { Event } from "@ocpp/schema/event"
import { EventManifest } from "@ocpp/schema/event-manifest"
import { Location } from "@ocpp/schema/location"
import type { Definition } from "@ocpp/schema/event"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

const fields = {
  id: Event.ID,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  location: Schema.optional(Location.Ref),
}

const schema = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) =>
  Schema.Union([
    ...definitions,
    ...(definitions.some((definition) => definition.type === "server-connected")
      ? []
      : [
          Schema.Struct({
            ...fields,
            type: Schema.Literal("server-connected"),
            data: Schema.Struct({}),
          }).annotate({ identifier: "V2Event.server-connected" }),
        ]),
  ]).annotate({ identifier: "V2Event" })

const make = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) => {
  const EventSchema = schema(definitions)
  return {
    schema: EventSchema,
    group: HttpApiGroup.make("server.event")
      .add(
        HttpApiEndpoint.get("event.subscribe", "/api/event", {
          success: HttpApiSchema.StreamSse({ data: EventSchema }),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "v2.event.subscribe",
            summary: "Subscribe to events",
            description:
              "Subscribe to native event payloads for the server. Volatile by contract: a slow consumer overflows and fails the stream, and events during disconnection are missed.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "event", description: "Experimental event stream routes." })),
  }
}

export const makeEventGroup = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) =>
  make(definitions).group

const event = make(EventManifest.ServerDefinitions)
export const EventGroup = event.group
export const OcppEvent = event.schema
export type OcppEvent = typeof OcppEvent.Type
export type OcppEventEncoded = typeof OcppEvent.Encoded
export const isOcppEvent = (event: { readonly type: string }): event is OcppEvent =>
  event.type === "server-connected" || EventManifest.isServer(event)
