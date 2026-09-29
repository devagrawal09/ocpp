import { EOL } from "node:os"
import path from "node:path"
import { readFile, rename, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Global } from "@ocpp/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { resolveConfigPath } from "../mcp/add"

export default Runtime.handler(
  Commands.commands.plugin.commands.remove,
  Effect.fn("cli.plugin.remove")(function* (input) {
    const global = yield* Global.Service
    const configPath = yield* Effect.promise(() => resolveConfigPath(global.config))
    const removed = yield* Effect.promise(() => removePluginConfig(configPath, input.package))
    process.stdout.write(
      removed
        ? `Plugin "${input.package}" removed from ${configPath}${EOL}`
        : `Plugin "${input.package}" is not configured${EOL}`,
    )
  }),
)

export async function removePluginConfig(configPath: string, spec: string) {
  const text = await readFile(configPath, "utf8").catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return false
  const errors: ParseError[] = []
  const config: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof config !== "object" || config === null || Array.isArray(config))
    throw new Error(`Invalid global configuration: ${configPath}`)
  const plugins = "plugins" in config ? config.plugins : undefined
  if (plugins !== undefined && !Array.isArray(plugins)) throw new Error(`Invalid plugins configuration: ${configPath}`)
  if (!configured(plugins, spec)) return false

  const updated = applyEdits(
    text,
    modify(
      text,
      ["plugins"],
      plugins?.filter((entry) => !matches(entry, spec)),
      {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      },
    ),
  )
  const temporary = configPath + ".tmp"
  await writeFile(temporary, updated.endsWith("\n") ? updated : updated + "\n", { mode: 0o600 })
  await rename(temporary, configPath)
  return true
}

function configured(plugins: readonly unknown[] | undefined, spec: string) {
  return plugins?.some((entry) => matches(entry, spec)) ?? false
}

function matches(entry: unknown, spec: string) {
  return entry === spec || (typeof entry === "object" && entry !== null && "package" in entry && entry.package === spec)
}
