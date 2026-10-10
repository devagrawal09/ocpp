import { createCommandSlice, event } from "@specter-ts/spec"

const created = (extra: Record<string, unknown> = {}) =>
  event("session-created", {
    sessionID: "ses_1",
    projectID: "prj_1",
    location: { directory: "/tmp/ws" },
    slug: "brave-otter",
    version: "2",
    ...extra,
  })
const deleted = event("session-deleted", { sessionID: "ses_1" })
const sonnet = { id: "sonnet", providerID: "anthropic" }
const opus = { id: "opus", providerID: "anthropic" }
type Ref = { id: string; providerID: string; variant?: string }
const selected = (model: Ref, previous?: Ref) =>
  event("session-model-selected", {
    sessionID: "ses_1",
    model,
    ...(previous === undefined ? {} : { previous }),
  })

export const selectModelSpec = createCommandSlice("selectModel")
  .description(
    "Selects the model a live Session runs on. The selection records the model it replaces: the one the Session was created with, or last selected. Selecting the model already selected records nothing; a model without a variant is its default variant.",
  )
  .scenarios(
    {
      description: "The model the Session was created with is the one the selection replaces.",
      given: [created({ model: sonnet })],
      when: { sessionID: "ses_1", model: opus },
      expect: [selected(opus, sonnet)],
    },
    {
      description: "The last selection is the one a new selection replaces.",
      given: [created({ model: sonnet }), selected(opus, sonnet)],
      when: { sessionID: "ses_1", model: { ...opus, variant: "high" } },
      expect: [selected({ ...opus, variant: "high" }, opus)],
    },
    {
      description: "A Session that never had a model replaces none.",
      given: [created()],
      when: { sessionID: "ses_1", model: opus },
      expect: [selected(opus)],
    },
    {
      description: "The model already selected is refused: there is nothing to change.",
      given: [created({ model: sonnet })],
      when: { sessionID: "ses_1", model: sonnet },
      expect: [],
      reject: { reason: "Model already selected" },
    },
    {
      description: "A model without a variant is the same selection as its default variant.",
      given: [created({ model: sonnet })],
      when: { sessionID: "ses_1", model: { ...sonnet, variant: "default" } },
      expect: [],
      reject: { reason: "Model already selected" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1", model: opus },
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created(), deleted],
      when: { sessionID: "ses_1", model: opus },
      expect: [],
      reject: { reason: "Session deleted" },
    },
  )

export default selectModelSpec
