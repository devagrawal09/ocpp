import { Schema } from "effect"
import { brand } from "./schema.js"

export const IntegrationID = Schema.String.pipe(brand("Integration.ID"))
export type IntegrationID = typeof IntegrationID.Type

export const IntegrationMethodID = Schema.String.pipe(brand("Integration.MethodID"))
export type IntegrationMethodID = typeof IntegrationMethodID.Type
