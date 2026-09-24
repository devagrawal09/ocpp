import { Plugin } from "@ocpp/plugin/tui"
import { createMermaidCodeBlockRenderer } from "./markdown.js"
import { resolveOcppDiagramPalette } from "./palette.js"

export default Plugin.define({
  id: "ocpp.merman",
  setup(context) {
    context.markdown.registerCodeBlockRenderer(
      "mermaid",
      createMermaidCodeBlockRenderer(context.renderer, () => ({
        colors: resolveOcppDiagramPalette(context.theme, context.themeMode),
      })),
    )
  },
})
