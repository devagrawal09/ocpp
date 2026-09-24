import { createProviderPlugin } from "./factory.js"

export const AlibabaPlugin = createProviderPlugin({
  id: "ocpp.provider.alibaba",
  package: "@ai-sdk/alibaba",
  load: async (options) => {
    const { createAlibaba } = await import("@ai-sdk/alibaba")
    return createAlibaba(options)
  },
})
