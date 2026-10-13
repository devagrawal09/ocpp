import type { Plugin } from "../../packages/plugin/src/promise/index.ts"

export default {
  id: "capability",
  async setup(ctx) {
    await ctx.tool.transform((tools) => tools.add(ctx.tool.evaluator))
  },
} satisfies Plugin.Plugin
