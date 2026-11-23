import type { Plugin } from "../../packages/plugin/src/promise/index.ts"

export default {
  id: "capability",
  async setup(ctx) {
    if (!ctx.tool.evaluator)
      throw new Error(
        "This running OC++ server predates the confined evaluator API. Restart the server your UI is connected to, or connect to an up-to-date server; restarting a different elected service is not sufficient.",
      )
    await ctx.tool.transform((tools) => tools.add(ctx.tool.evaluator))
  },
} satisfies Plugin.Plugin
