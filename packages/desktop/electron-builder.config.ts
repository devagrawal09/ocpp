import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// Linux packages also ship a hidden "ocpp-desktop" launcher alongside the canonical
// ai.ocpp.desktop entry, so desktop-file lookups by either name resolve to one app.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "ocpp-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/ocpp-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OCPP_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "ai.ocpp.desktop.dev",
  beta: "ai.ocpp.desktop.beta",
  prod: "ai.ocpp.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  artifactName: "ocpp-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.ocpp.desktop" becomes
  // "ai.ocpp.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: [
    "out/**/*",
    "resources/**/*",
    "!resources/ocpp-cli*",
    // Log export imports Zip.js as ESM. Keep index.js and lib, including its inline worker.
    "!**/node_modules/@zip.js/zip.js/dist{,/**/*}",
    "!**/node_modules/@zip.js/zip.js/{index.cjs,index.min.js,index-fflate.js,deno.json,eslint.config.mjs}",
    // These packages execute compiled JavaScript, not their sources or source maps.
    "!**/node_modules/{electron-updater,builder-util-runtime,lazy-val}/out/**/*.js.map",
    "!**/node_modules/ajv/lib{,/**/*}",
    "!**/node_modules/ajv-formats/src{,/**/*}",
    "!**/node_modules/{ajv,ajv-formats}/dist/**/*.js.map",
    // Keep js-yaml's CommonJS sources and dist/js-yaml.mjs ESM entry, not browser bundles or its CLI.
    "!**/node_modules/js-yaml/dist/{js-yaml.js,js-yaml.min.js,*.map}",
    "!**/node_modules/js-yaml/bin{,/**/*}",
  ],
  extraResources:
    channel !== "prod"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["ocpp-cli*"],
          },
        ]
      : [],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "OC++",
    schemes: ["ocpp"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "OC++ Dev",
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "ocpp-dev", fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "OC++ Beta",
        protocols: { name: "OC++ Beta", schemes: ["ocpp"] },
        publish: { provider: "github", owner: "devagrawal09", repo: "oc-plus-plus-beta", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "ocpp-beta", fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "OC++",
        protocols: { name: "OC++", schemes: ["ocpp"] },
        publish: { provider: "github", owner: "devagrawal09", repo: "oc-plus-plus", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
        rpm: { packageName: "ocpp", fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
