import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"
import { auditPackage } from "./scripts/package-content"
import { packagePruningPatterns } from "./scripts/package-pruning"
import { findSharedRendererAssets } from "./scripts/shared-renderer-assets"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const rendererAssets = path.join(packageDir, "out/renderer")
const sharedAssets = findSharedRendererAssets(rendererAssets, path.join(packageDir, "resources/remote-web"))

// Custom signer so electron-builder still runs rcedit (icon + version metadata).
// `signAndEditExecutable: false` skips both signing AND icon embedding.
async function signWindows(configuration: { path: string }) {
  console.log(
    `[desktop] windows sign hook path=${configuration.path} platform=${process.platform} gha=${process.env.GITHUB_ACTIONS ?? ""}`,
  )
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  artifactName: "opencode-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so desktopName is the desktop file name.
  // For prod, app id "ai.opencode.desktop" becomes "ai.opencode.desktop.desktop".
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: [
    "out/**/*",
    "!**/*.map",
    "package.json",
    // These source-only workspace packages and the tunnel SDK are bundled by
    // electron-vite. Keep metadata/licenses, not a second runtime/source tree.
    "!node_modules/@opencode-ai/{core,util,remote-tunnel}/{src,test,tests,scripts}/**/*",
    "!node_modules/@opencode-ai/remote-tunnel/node_modules/**/*",
    "!node_modules/@opentunnel/{client,protocol}/dist/**/*",
    "!node_modules/@opentunnel/{client,protocol}/src/**/*",
    "!node_modules/effect/src/**/*",
    "!node_modules/effect/ai-docs/**/*",
    "!**/node_modules/**/{AGENTS,CLAUDE}.md",
    ...packagePruningPatterns,
    ...sharedAssets.map((asset) => `!out/renderer/${asset}`),
  ],
  afterPack: async (context) => {
    const resources =
      context.electronPlatformName === "darwin"
        ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
        : path.join(context.appOutDir, "resources")
    const report = await auditPackage(resources)
    const packaged = new Set(report.entries.map((entry) => entry.path))
    const present = new Set(findSharedRendererAssets(rendererAssets, path.join(resources, "remote-web")))
    for (const asset of sharedAssets) {
      if (packaged.has(`out/renderer/${asset}`) || !present.has(asset)) {
        throw new Error(`Shared renderer asset was not deduplicated correctly: ${asset}`)
      }
    }
    await writeFile(path.join(resources, "shared-renderer-assets.json"), JSON.stringify(sharedAssets))
    console.log(`[desktop] shared renderer assets=${sharedAssets.length}`)
  },
  extraResources: [
    { from: "resources/gpt-pro-login", to: "gpt-pro-login", filter: ["**/*"] },
    {
      from: "resources/icons",
      to: "icons",
    },
    {
      from: "resources/sidecars",
      to: "sidecars",
      filter: ["**/*"],
    },
    {
      from: "resources/remote-web",
      to: "remote-web",
      filter: ["**/*"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: "resources/icons/icon.icns",
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
    name: "OpenCode",
    schemes: ["opencode"],
  },
  win: {
    icon: "resources/icons/windows.ico",
    target: ["nsis"],
    signtoolOptions: {
      sign: signWindows,
      signingHashAlgorithms: ["sha256"],
    },
    verifyUpdateCodeSignature: false,
    forceCodeSigning: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: "resources/icons/windows.ico",
    installerHeaderIcon: "resources/icons/windows.ico",
    uninstallerIcon: "resources/icons/windows.ico",
  },
  linux: {
    icon: "resources/icons",
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
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
        productName: "OpenCode Dev",
        // Dev channel: no publish provider (local development only)
        publish: null,
        rpm: { packageName: "opencode-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "OpenCode Beta",
        protocols: { name: "OpenCode Beta", schemes: ["opencode"] },
        publish: { provider: "github", owner: "panyw5", repo: "opencode", channel: "latest" },
        rpm: { packageName: "opencode-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "OpenCode",
        protocols: { name: "OpenCode", schemes: ["opencode"] },
        publish: { provider: "github", owner: "panyw5", repo: "opencode", channel: "latest" },
        rpm: { packageName: "opencode" },
      }
    }
  }
}

export default getConfig()
