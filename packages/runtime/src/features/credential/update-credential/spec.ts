import { createCommandSlice, event } from "@specter-ts/spec"

const secret = { iv: "aXY=", data: "c2VhbGVk" }
const rotated = { iv: "bmV3", data: "cm90YXRlZA==" }
const created = event("credential-created", {
  credentialID: "cred_1",
  integrationID: "anthropic",
  label: "default",
  secret,
})
const relabeled = (label: string) =>
  event("credential-relabeled", { credentialID: "cred_1", integrationID: "anthropic", label })
const removed = event("credential-removed", { credentialID: "cred_1", integrationID: "anthropic" })

export const updateCredentialSpec = createCommandSlice("updateCredential")
  .description(
    "Changes a credential's label, its secret, or both in one commit. The host seals the new secret under the credential's own key. The label it has already, without a new secret, records nothing.",
  )
  .scenarios(
    {
      description: "A new label and a new secret are recorded together.",
      given: [created],
      when: { credentialID: "cred_1", label: "work", secret: rotated },
      expect: [
        relabeled("work"),
        event("credential-rotated", { credentialID: "cred_1", integrationID: "anthropic", secret: rotated }),
      ],
    },
    {
      description: "The label it has already is not recorded again; the secret still rotates.",
      given: [created, relabeled("work")],
      when: { credentialID: "cred_1", label: "work", secret: rotated },
      expect: [event("credential-rotated", { credentialID: "cred_1", integrationID: "anthropic", secret: rotated })],
    },
    {
      description: "A new label alone relabels it.",
      given: [created],
      when: { credentialID: "cred_1", label: "work" },
      expect: [relabeled("work")],
    },
    {
      description: "The label it has, and no secret, is refused, and the host answers as done.",
      given: [created, relabeled("work")],
      when: { credentialID: "cred_1", label: "work" },
      expect: [],
      reject: { code: "credential-unchanged" },
    },
    {
      description: "A removed credential is refused.",
      given: [created, removed],
      when: { credentialID: "cred_1", label: "work" },
      expect: [],
      reject: { code: "credential-not-found" },
    },
  )

export default updateCredentialSpec
