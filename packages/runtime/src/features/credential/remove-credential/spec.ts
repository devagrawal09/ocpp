import { createCommandSlice, event } from "@specter-ts/spec"

const secret = { iv: "aXY=", data: "c2VhbGVk" }
const created = (credentialID: string, integrationID = "anthropic") =>
  event("credential-created", { credentialID, integrationID, label: credentialID, secret })
const activated = (credentialID: string) => event("credential-activated", { credentialID, integrationID: "anthropic" })
const removed = (credentialID: string, replacement?: string) =>
  event(
    "credential-removed",
    replacement
      ? { credentialID, integrationID: "anthropic", replacement }
      : { credentialID, integrationID: "anthropic" },
  )

export const removeCredentialSpec = createCommandSlice("removeCredential")
  .description(
    "Removes a credential with its secret; the host deletes its key with it. When the integration used it, the newest of its remaining credentials replaces it in the same commit, so an integration with credentials always uses one.",
  )
  .scenarios(
    {
      description: "A credential the integration does not use is removed alone.",
      given: [created("cred_1"), created("cred_2")],
      when: { credentialID: "cred_1" },
      expect: [removed("cred_1")],
    },
    {
      description: "The credential in use is replaced by the newest remaining one.",
      given: [created("cred_1"), created("cred_2"), created("cred_3"), activated("cred_3"), removed("cred_2")],
      when: { credentialID: "cred_3" },
      expect: [removed("cred_3", "cred_1")],
    },
    {
      description: "Another integration's credentials never replace it.",
      given: [created("cred_1"), created("cred_2", "openai")],
      when: { credentialID: "cred_1" },
      expect: [removed("cred_1")],
    },
    {
      description: "An unknown credential is refused, and the host answers as done.",
      given: [],
      when: { credentialID: "cred_1" },
      expect: [],
      reject: { code: "credential-not-found" },
    },
  )

export default removeCredentialSpec
