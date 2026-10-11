import { createCommandSlice, event } from "@specter-ts/spec"

const stored = (value: { readonly mode: string }) => event("kv-stored", { key: "plugin:theme", value })
const removed = event("kv-removed", { key: "plugin:theme" })

export const storeValueSpec = createCommandSlice("storeValue")
  .description(
    "Stores a JSON value under a key of the key-value store: a plugin's own storage, the web search provider, the well-known origins. Storing the value a key holds already records nothing.",
  )
  .scenarios(
    {
      description: "A value is stored under a new key.",
      given: [],
      when: { key: "plugin:theme", value: { mode: "dark" } },
      expect: [stored({ mode: "dark" })],
    },
    {
      description: "A different value replaces the one the key holds.",
      given: [stored({ mode: "dark" })],
      when: { key: "plugin:theme", value: { mode: "light" } },
      expect: [stored({ mode: "light" })],
    },
    {
      description: "The value the key holds already is refused, and the host answers as if it had stored it.",
      given: [stored({ mode: "dark" })],
      when: { key: "plugin:theme", value: { mode: "dark" } },
      expect: [],
      reject: { code: "value-unchanged" },
    },
    {
      description: "A removed key stores its value again.",
      given: [stored({ mode: "dark" }), removed],
      when: { key: "plugin:theme", value: { mode: "dark" } },
      expect: [stored({ mode: "dark" })],
    },
  )

export default storeValueSpec
