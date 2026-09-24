import path from "node:path"

export function isolatedEnv(root: string, overrides: Record<string, string | undefined> = {}) {
  return {
    ...process.env,
    HOME: root,
    OCPP_CONFIG_CONTENT: "{}",
    OCPP_CONFIG_DIR: path.join(root, "config"),
    OCPP_DB: path.join(root, "ocpp.db"),
    OCPP_DISABLE_FILEWATCHER: "true",
    OCPP_DISABLE_MODELS_FETCH: "true",
    OCPP_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    ...overrides,
  }
}
