import { createCommandSlice, event } from "@specter-ts/spec"

const secret = { iv: "aXY=", data: "c2VhbGVk" }
const created = event("credential-created", {
  credentialID: "cred_1",
  integrationID: "anthropic",
  label: "default",
  secret,
})

export const createCredentialSpec = createCommandSlice("createCredential")
  .description(
    "Stores a credential for an integration, with its secret sealed under a key of its own that the host keeps beside the log, and makes it the one the integration uses. A credential ID names one credential.",
  )
  .scenarios(
    {
      description: "A new credential is stored and becomes the one its integration uses.",
      given: [],
      when: { credentialID: "cred_1", integrationID: "anthropic", label: "default", secret },
      expect: [created],
    },
    {
      description: "A credential that exists is refused.",
      given: [created],
      when: { credentialID: "cred_1", integrationID: "anthropic", label: "default", secret },
      expect: [],
      reject: { reason: "Credential already exists" },
    },
    {
      description: "A removed credential's ID is gone with its key, and stores a credential again.",
      given: [created, event("credential-removed", { credentialID: "cred_1", integrationID: "anthropic" })],
      when: { credentialID: "cred_1", integrationID: "anthropic", label: "default", secret },
      expect: [created],
    },
  )

export default createCredentialSpec
