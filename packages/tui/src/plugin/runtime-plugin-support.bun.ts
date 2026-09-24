import { Plugin, PluginContextProvider, usePlugin } from "@ocpp/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensureRuntimePluginSupport({
  additional: {
    "@ocpp/plugin/tui": { Plugin, PluginContextProvider, usePlugin },
  },
})
