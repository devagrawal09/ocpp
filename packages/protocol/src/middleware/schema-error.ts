import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors.js"

export class SchemaErrorMiddleware extends HttpApiMiddleware.Service<SchemaErrorMiddleware>()(
  "@ocpp/HttpApiSchemaError",
  { error: InvalidRequestError },
) {}
