import path from "node:path"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { defineConfig, type Plugin, type UserConfig } from "vite"
import solid from "vite-plugin-solid"
import { nodeExecArgv, nodeTarget, type NodeTarget, photonWasmAsset, shellParserWasmAssets } from "./src/node/target"
import { verifySimulationGraph } from "./script/verify-artifact"

const dir = import.meta.dirname

function rawTextPlugin(): Plugin {
  return {
    name: "ocpp:raw-text",
    // "pre" is load-bearing for .txt: Vite's built-in asset plugin claims
    // known asset types (.txt among them) ahead of normal-priority plugins,
    // replacing the import with an asset URL string instead of the content.
    // .md only ever worked without it because .md is not a known asset type.
    enforce: "pre",
    async load(id) {
      if (!id.endsWith(".md") && !id.endsWith(".txt")) return
      return `export default ${JSON.stringify(await readFile(id, "utf8"))}`
    },
  }
}

function appAssetsPlugin(archive: string): Plugin {
  return {
    name: "ocpp:app-assets",
    resolveId(id) {
      if (id === "virtual:ocpp-app-assets") return "\0virtual:ocpp-app-assets"
    },
    load(id) {
      if (id !== "\0virtual:ocpp-app-assets") return
      return `export default ${JSON.stringify(archive)}`
    },
  }
}

function runtimeRequirePlugin(): Plugin {
  return {
    name: "ocpp:runtime-require",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("turndown/lib/turndown.es.js")) return
      const transformed = code.replace("    var domino = require('@mixmark-io/domino');", "")
      if (transformed === code) this.error("Failed to rewrite Turndown's Domino require")
      return `import domino from "@mixmark-io/domino"\n${transformed}`
    },
  }
}

function simulationGraphPlugin(): Plugin {
  return {
    name: "ocpp:simulation-graph",
    generateBundle() {
      verifySimulationGraph(this.getModuleIds())
    },
  }
}

function fffNodePlugin(): Plugin {
  return {
    name: "ocpp:fff-node",
    enforce: "pre",
    transform(code, id) {
      const normalized = id.replaceAll("\\", "/")
      if (normalized.endsWith("/ffi-rs/index.js")) {
        const start = code.indexOf("if (!nativeBinding) {")
        if (start === -1) this.error("Failed to rewrite ffi-rs native binding loader")
        return `const unavailable = () => { throw new Error("ffi-rs native binding unavailable") }
const nativeBinding = globalThis.__OCPP_FFF_FFI ?? {
  DataType: new Proxy({}, { get: (target, key) => target[key] ?? key }),
  PointerType: {},
  FFITypeTag: {},
  open: unavailable,
  close: unavailable,
  load: unavailable,
  isNullPointer: unavailable,
  createPointer: unavailable,
  restorePointer: unavailable,
  unwrapPointer: unavailable,
  wrapPointer: unavailable,
  freePointer: unavailable,
}
const loadError = undefined
${code.slice(start)}`
      }
      if (!normalized.endsWith("/fff-node/dist/src/binary.js")) return
      const transformed = code.replace(
        "export function findBinary() {",
        "export function findBinary() { if (process.env.FFF_BINARY_PATH) return process.env.FFF_BINARY_PATH;",
      )
      if (transformed === code) this.error("Failed to rewrite FFF binary loader")
      return transformed
    },
  }
}

const resolve = {
  alias: [
    { find: /^solid-js\/store$/, replacement: "solid-js/store/dist/store.js" },
    { find: /^solid-js$/, replacement: "solid-js/dist/solid.js" },
    {
      find: /^ws$/,
      replacement: path.join(path.dirname(createRequire(import.meta.url).resolve("ws/package.json")), "wrapper.mjs"),
    },
  ],
  conditions: ["node"],
}

const output = (entryFileNames: string, banner?: string) => ({
  format: "esm" as const,
  entryFileNames,
  inlineDynamicImports: true,
  banner,
})

function nodePrelude(input: NodeBuildInput) {
  const nodePtySpawnHelper =
    input.target.platform === "darwin"
      ? `${input.target.nodePtyPackage}/prebuilds/darwin-${input.target.arch}/spawn-helper`
      : undefined
  const opencodePtyAsset = input.target.opencodePtyAsset
  const promiseModule = `const sdk = globalThis[Symbol.for("ocpp.plugin.v2.promise")]
if (!sdk) throw new Error("OC++ Promise plugin SDK is unavailable")
export const Agent = sdk.Agent
export const Command = sdk.Command
export const Connection = sdk.Connection
export const Credential = sdk.Credential
export const Integration = sdk.Integration
export const Model = sdk.Model
export const Plugin = sdk.Plugin
export const Provider = sdk.Provider
export const Reference = sdk.Reference
export const Skill = sdk.Skill`
  const effectModule = promiseModule
    .replace("ocpp.plugin.v2.promise", "ocpp.plugin.v2.effect")
    .replace("Promise plugin", "Effect plugin")
  const promisePluginModule = `const sdk = globalThis[Symbol.for("ocpp.plugin.v2.promise")]
if (!sdk) throw new Error("OC++ Promise plugin SDK is unavailable")
export const define = sdk.Plugin.define`
  const effectPluginModule = promisePluginModule
    .replace("ocpp.plugin.v2.promise", "ocpp.plugin.v2.effect")
    .replace("Promise plugin", "Effect plugin")
  const promiseToolModule = `export {}`
  const effectToolModule = `const sdk = globalThis[Symbol.for("ocpp.plugin.v2.effect")]
if (!sdk) throw new Error("OC++ Effect plugin SDK is unavailable")
export const Error = sdk.Tool.Error
`
  return `#!/usr/bin/env -S node ${nodeExecArgv.join(" ")}
import __cjs_mod__ from "node:module"
import { chmodSync as __ocppChmod, existsSync as __ocppExists, lstatSync as __ocppLstat, mkdirSync as __ocppMkdir, renameSync as __ocppRename, rmSync as __ocppRm, writeFileSync as __ocppWrite } from "node:fs"
import { tmpdir as __ocppTmpdir } from "node:os"
import __ocppPath from "node:path"
import { getAssetKeys as __ocppAssetKeys, getRawAsset as __ocppRawAsset, isSea as __ocppIsSea } from "node:sea"
import { fileURLToPath as __ocppFileURLToPath } from "node:url"
const __filename = import.meta.filename
const __dirname = import.meta.dirname
const require = __cjs_mod__.createRequire(import.meta.url)
const __ocppPluginModules = ${JSON.stringify({
    "@ocpp/plugin": "ocpp:plugin-v2",
    "@ocpp/plugin/promise/plugin": "ocpp:plugin-promise-plugin",
    "@ocpp/plugin/promise/tool": "ocpp:plugin-promise-tool",
    "@ocpp/plugin/effect": "ocpp:plugin-v2-effect",
    "@ocpp/plugin/effect/plugin": "ocpp:plugin-v2-effect-plugin",
    "@ocpp/plugin/effect/tool": "ocpp:plugin-v2-effect-tool",
  })}
const __ocppPluginSources = ${JSON.stringify({
    "ocpp:plugin-v2": promiseModule,
    "ocpp:plugin-promise-plugin": promisePluginModule,
    "ocpp:plugin-promise-tool": promiseToolModule,
    "ocpp:plugin-v2-effect": effectModule,
    "ocpp:plugin-v2-effect-plugin": effectPluginModule,
    "ocpp:plugin-v2-effect-tool": effectToolModule,
  })}
__cjs_mod__.registerHooks({
  resolve(__ocppSpecifier, __ocppContext, __ocppNextResolve) {
    const __ocppUrl = __ocppPluginModules[__ocppSpecifier]
    return __ocppUrl ? { url: __ocppUrl, shortCircuit: true } : __ocppNextResolve(__ocppSpecifier, __ocppContext)
  },
  load(__ocppUrl, __ocppContext, __ocppNextLoad) {
    const __ocppSource = __ocppPluginSources[__ocppUrl]
    return __ocppSource
      ? { format: "module", source: __ocppSource, shortCircuit: true }
      : __ocppNextLoad(__ocppUrl, __ocppContext)
  },
})
const __ocppUid = typeof process.getuid === "function" ? process.getuid() : undefined
const __ocppCacheRoot = __ocppPath.join(__ocppTmpdir(), \`ocpp-node-\${__ocppUid ?? "user"}\`)
if (__ocppIsSea()) {
  try {
    __ocppMkdir(__ocppCacheRoot, { mode: 0o700 })
  } catch (__ocppError) {
    if (!__ocppExists(__ocppCacheRoot)) throw __ocppError
  }
  const __ocppCacheInfo = __ocppLstat(__ocppCacheRoot)
  if (!__ocppCacheInfo.isDirectory() || __ocppCacheInfo.isSymbolicLink()) throw new Error("Unsafe Node asset cache path")
  if (__ocppUid !== undefined && __ocppCacheInfo.uid !== __ocppUid) throw new Error("Node asset cache is owned by another user")
  if (__ocppUid !== undefined) __ocppChmod(__ocppCacheRoot, 0o700)
}
const __ocppAssetRoot = __ocppIsSea()
  ? __ocppPath.join(__ocppCacheRoot, ${JSON.stringify(`${input.assetHash}-${input.target.platform}-${input.target.arch}`)})
  : __ocppFileURLToPath(new URL("./assets/", import.meta.url))
const __ocppPersistentPty = ${JSON.stringify(opencodePtyAsset)}
if (__ocppIsSea()) {
  const __ocppPtySpawnHelper = ${JSON.stringify(nodePtySpawnHelper)}
  for (const __ocppKey of __ocppAssetKeys()) {
    const __ocppTarget = __ocppPath.join(__ocppAssetRoot, __ocppKey)
    if (__ocppExists(__ocppTarget)) continue
    __ocppMkdir(__ocppPath.dirname(__ocppTarget), { recursive: true })
    const __ocppTemporary = \`${"${__ocppTarget}"}.${"${process.pid}"}.${"${crypto.randomUUID()}"}.tmp\`
    __ocppWrite(__ocppTemporary, new Uint8Array(__ocppRawAsset(__ocppKey)))
    if ((__ocppKey === __ocppPtySpawnHelper || __ocppKey === __ocppPersistentPty) && process.platform !== "win32")
      __ocppChmod(__ocppTemporary, 0o755)
    try {
      __ocppRename(__ocppTemporary, __ocppTarget)
    } catch (__ocppError) {
      __ocppRm(__ocppTemporary, { force: true })
      if (!__ocppExists(__ocppTarget)) throw __ocppError
    }
  }
}
process.env.OCPP_NODE_ASSETS_DIR = __ocppAssetRoot
process.env.OTUI_ASSET_ROOT = __ocppAssetRoot
process.env.OCPP_NODE_PTY_PATH = __ocppPath.join(__ocppAssetRoot, ${JSON.stringify(input.target.nodePtyEntryAsset)})
process.env.OCPP_PARCEL_WATCHER_PATH = __ocppPath.join(__ocppAssetRoot, ${JSON.stringify(input.target.parcelWatcherAsset)})
process.env.OCPP_PHOTON_WASM_PATH = __ocppPath.join(__ocppAssetRoot, ${JSON.stringify(photonWasmAsset)})
process.env.OCPP_TREE_SITTER_WASM_PATH = __ocppPath.join(__ocppAssetRoot, ${JSON.stringify(shellParserWasmAssets.runtime)})
process.env.OCPP_TREE_SITTER_BASH_WASM_PATH = __ocppPath.join(__ocppAssetRoot, ${JSON.stringify(shellParserWasmAssets.bash)})
process.env.OCPP_TREE_SITTER_POWERSHELL_WASM_PATH = __ocppPath.join(__ocppAssetRoot, ${JSON.stringify(shellParserWasmAssets.powershell)})
process.env.FFF_BINARY_PATH = __ocppPath.join(__ocppAssetRoot, ${JSON.stringify(input.target.fffAsset)})
process.env.OCPP_FFF_FFI_PATH = __ocppPath.join(__ocppAssetRoot, ${JSON.stringify(input.target.fffFfiAsset)})
if (__ocppPersistentPty && !process.env.OCPP_PTY_BIN) process.env.OCPP_PTY_BIN = __ocppPath.join(__ocppAssetRoot, __ocppPersistentPty)
try {
  globalThis.__OCPP_FFF_FFI = require(process.env.OCPP_FFF_FFI_PATH)
} catch {}
globalThis.__OCPP_PHOTON_WASM_PATH = process.env.OCPP_PHOTON_WASM_PATH
if (process.platform === "linux") process.env.OPENTUI_LIBC = "glibc"`
}

export type NodeBuildInput = {
  readonly version: string
  readonly channel: string
  readonly assetHash: string
  readonly target: NodeTarget
  readonly appArchive: string
}

export function mainConfig(input: NodeBuildInput): UserConfig {
  return defineConfig({
    root: dir,
    plugins: [
      appAssetsPlugin(input.appArchive),
      rawTextPlugin(),
      runtimeRequirePlugin(),
      fffNodePlugin(),
      simulationGraphPlugin(),
      solid({
        solid: {
          generate: "universal",
          moduleName: "@opentui/solid",
        },
      }),
    ],
    resolve,
    esbuild: { jsx: "automatic" },
    define: {
      OCPP_VERSION: JSON.stringify(input.version),
      OCPP_CLI_NAME: JSON.stringify("ocpp-node"),
      OCPP_CHANNEL: JSON.stringify(input.channel),
      OCPP_LIBC: input.target.platform === "linux" ? JSON.stringify("glibc") : "undefined",
      FFF_LIBC: input.target.platform === "linux" ? JSON.stringify("gnu") : "undefined",
      "process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1"),
    },
    ssr: { noExternal: true },
    build: {
      ssr: "src/node/index.ts",
      target: "node26",
      outDir: "dist-node",
      emptyOutDir: false,
      minify: true,
      rollupOptions: {
        output: output("ocpp.mjs", nodePrelude(input)),
      },
    },
  })
}

export default mainConfig({
  version: process.env.OCPP_VERSION ?? "local",
  channel: process.env.OCPP_CHANNEL ?? "local",
  assetHash: "local",
  target: nodeTarget(process.platform, process.arch),
  appArchive: "",
})
