import path from "path"

process.env.OCPP_DB = ":memory:"
process.env.OCPP_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.OCPP_DISABLE_MODELS_FETCH = "true"
