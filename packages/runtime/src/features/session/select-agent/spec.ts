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
const selected = (agent: string, previous?: string) =>
  event("session-agent-selected", {
    sessionID: "ses_1",
    agent,
    ...(previous === undefined ? {} : { previous }),
  })

export const selectAgentSpec = createCommandSlice("selectAgent")
  .description(
    "Selects the agent a live Session runs as. The selection records the agent it replaces: the one the Session was created with, or last selected.",
  )
  .scenarios(
    {
      description: "The agent the Session was created with is the one the selection replaces.",
      given: [created({ agent: "build" })],
      when: { sessionID: "ses_1", agent: "plan" },
      expect: [selected("plan", "build")],
    },
    {
      description: "The last selection is the one a new selection replaces.",
      given: [created({ agent: "build" }), selected("plan", "build")],
      when: { sessionID: "ses_1", agent: "review" },
      expect: [selected("review", "plan")],
    },
    {
      description: "A Session that never had an agent replaces none.",
      given: [created()],
      when: { sessionID: "ses_1", agent: "plan" },
      expect: [selected("plan")],
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1", agent: "plan" },
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created(), deleted],
      when: { sessionID: "ses_1", agent: "plan" },
      expect: [],
      reject: { reason: "Session deleted" },
    },
  )

export default selectAgentSpec
