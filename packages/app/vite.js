import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/ocpp-theme-preload.js", import.meta.url))
const themeScript = readFileSync(theme, "utf8")
const tailwind = tailwindcss()
const tailwindGenerate = tailwind.find((plugin) => plugin.name === "@tailwindcss/vite:generate:serve")
const tailwindHotUpdate = tailwindGenerate?.hotUpdate

// Tailwind 4.3.3 expects a server that Vite's bundled dev hook does not provide.
if (tailwindGenerate && typeof tailwindHotUpdate === "function") {
  tailwindGenerate.hotUpdate = function (context) {
    if (!context.server) return
    return tailwindHotUpdate.call(this, context)
  }
}

export const channel = (() => {
  const raw = process.env.OCPP_CHANNEL
  if (raw === "local" || raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OCPP_CHANNEL === "latest") return "prod"
  return "dev"
})()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "ocpp-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        define: {
          "import.meta.env.VITE_OCPP_CHANNEL": JSON.stringify(channel),
        },
        worker: {
          format: "es",
        },
        optimizeDeps: {
          exclude: ["@shikijs/stream", "marked", "marked-shiki", "remend"],
          include: ["@ocpp/session-ui > mermaid", "@ocpp/session-ui > mermaid > katex"],
        },
      }
    },
  },
  {
    name: "ocpp-desktop:theme-preload",
    transformIndexHtml: {
      order: "pre",
      handler: inlineThemePreload,
    },
  },
  ...tailwind,
  solidPlugin(),
]

export function inlineThemePreload(html) {
  return html.replace(
    /<script id="ocpp-theme-preload-script" src="(?:\.\/|\/)ocpp-theme-preload\.js"><\/script>/,
    `<script id="ocpp-theme-preload-script">${themeScript}</script>`,
  )
}
