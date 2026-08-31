import { Plugin } from "../../packages/plugin/src/promise/index.ts"

const builtins = new Set([
  "edit",
  "glob",
  "grep",
  "patch",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "webfetch",
  "websearch",
  "write",
])

export default Plugin.define({
  id: "opencode.codemode-only",
  async setup(ctx) {
    await ctx.tool.transform((draft) => {
      for (const item of draft.list()) {
        if (!builtins.has(item.id)) continue
        draft.update(item.id, (tool) => {
          tool.options = { ...tool.options, codemode: true }
        })
      }
    })

    await ctx.agent.transform((draft) => {
      for (const item of draft.list()) {
        if (item.hidden) continue
        draft.update(String(item.id), (agent) => {
          agent.permissions.push({ action: "execute", resource: "*", effect: "allow" })
        })
      }
    })

    await ctx.session.hook("context", (event) => {
      for (const name of Object.keys(event.tools)) {
        if (name !== "execute") delete event.tools[name]
      }
    })
  },
})
