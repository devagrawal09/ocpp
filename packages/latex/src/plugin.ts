import { Plugin } from "@ocpp/plugin/tui"
import { createLatexCodeBlockRenderer } from "./markdown"

export default Plugin.define({
  id: "ocpp.latex",
  setup(context) {
    const render = createLatexCodeBlockRenderer(context.renderer, () => ({
      text: context.theme.text.default,
      subdued: context.theme.text.subdued,
    }))
    context.markdown.registerCodeBlockRenderer("latex", render)
    context.markdown.registerCodeBlockRenderer("math", render)
  },
})
