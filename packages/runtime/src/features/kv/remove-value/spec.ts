import { createCommandSlice, event } from "@specter-ts/spec"

const stored = event("kv-stored", { key: "plugin:theme", value: { mode: "dark" } })
const removed = event("kv-removed", { key: "plugin:theme" })

export const removeValueSpec = createCommandSlice("removeValue")
  .description("Removes the value a key of the key-value store holds. A key without a value records nothing.")
  .scenarios(
    {
      description: "A stored value is removed.",
      given: [stored],
      when: { key: "plugin:theme" },
      expect: [removed],
    },
    {
      description: "A key that never held a value is refused, and the host answers as if it had removed it.",
      given: [],
      when: { key: "plugin:theme" },
      expect: [],
      reject: { code: "value-not-found" },
    },
    {
      description: "A removed key is refused too.",
      given: [stored, removed],
      when: { key: "plugin:theme" },
      expect: [],
      reject: { code: "value-not-found" },
    },
  )

export default removeValueSpec
