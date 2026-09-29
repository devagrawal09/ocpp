import { describe, expect, test } from "bun:test"
import { migrateModelSelection } from "./selection"

describe("migrateModelSelection", () => {
  test("drops selections saved before they held only picks, so the stored Session model wins", () => {
    const fallback = { agent: "build", model: { providerID: "opencode", modelID: "gpt-5.5" }, variant: null }
    expect(migrateModelSelection({ session: { ses_scripted: fallback } })).toEqual({ version: 2, session: {} })
    expect(migrateModelSelection({ pick: { ses_scripted: fallback } })).toEqual({ version: 2, session: {} })
    expect(migrateModelSelection(undefined)).toEqual({ version: 2, session: {} })
  })

  test("keeps picks saved since", () => {
    const saved = { version: 2, session: { ses_claude: { model: { providerID: "claude", modelID: "opus" } } } }
    expect(migrateModelSelection(saved)).toBe(saved)
  })
})
