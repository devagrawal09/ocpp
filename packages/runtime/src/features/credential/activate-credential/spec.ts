import { createCommandSlice, event } from "@specter-ts/spec"

const secret = { iv: "aXY=", data: "c2VhbGVk" }
const created = (credentialID: string) =>
  event("credential-created", { credentialID, integrationID: "anthropic", label: credentialID, secret })
const activated = (credentialID: string) => event("credential-activated", { credentialID, integrationID: "anthropic" })
const removed = (credentialID: string, replacement?: string) =>
  event(
    "credential-removed",
    replacement
      ? { credentialID, integrationID: "anthropic", replacement }
      : { credentialID, integrationID: "anthropic" },
  )

export const activateCredentialSpec = createCommandSlice("activateCredential")
  .description(
    "Switches an integration to one of its credentials: exactly one credential of an integration is the one it uses. The credential it uses already records nothing.",
  )
  .scenarios(
    {
      description: "An integration switches to an older credential.",
      given: [created("cred_1"), created("cred_2")],
      when: { credentialID: "cred_1" },
      expect: [activated("cred_1")],
    },
    {
      description: "The credential the integration uses is refused, and the host answers as done.",
      given: [created("cred_1"), created("cred_2"), activated("cred_1")],
      when: { credentialID: "cred_1" },
      expect: [],
      reject: { reason: "Credential already active" },
    },
    {
      description: "The credential that replaced a removed one is the one in use.",
      given: [created("cred_1"), created("cred_2"), removed("cred_2", "cred_1")],
      when: { credentialID: "cred_1" },
      expect: [],
      reject: { reason: "Credential already active" },
    },
    {
      description: "An unknown credential is refused.",
      given: [],
      when: { credentialID: "cred_1" },
      expect: [],
      reject: { reason: "Credential not found" },
    },
    {
      description: "A removed credential is refused.",
      given: [created("cred_1"), removed("cred_1")],
      when: { credentialID: "cred_1" },
      expect: [],
      reject: { reason: "Credential not found" },
    },
  )

export default activateCredentialSpec
