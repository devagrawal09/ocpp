import type { PluginInfo } from "@ocpp/client"

export function pluginLabel(plugin: PluginInfo) {
  if (plugin.id) return plugin.id
  if (plugin.source.type === "package") return plugin.source.package
  if (plugin.source.type === "local") return plugin.source.path
  return plugin.source.type
}

export function pluginLabels(plugins: readonly PluginInfo[]) {
  return plugins.filter((plugin) => plugin.source.type !== "builtin").map(pluginLabel)
}
