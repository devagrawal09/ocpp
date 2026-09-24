const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://ocpp.ai" : `https://${stage}.ocpp.ai`,
  console: stage === "production" ? "https://opencode.ai/auth" : `https://${stage}.opencode.ai/auth`,
  email: "help@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/devagrawal09/oc-plus-plus",
  discord: "https://ocpp.ai/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
