import { $ } from "bun"
import { getCurrentSidecar, windowsify, copyBinaryToSidecarFolder, resolveChannel } from "./utils"

const channel = resolveChannel()
const env = { ...Bun.env, OPENCODE_CHANNEL: channel }

await $`bun ./scripts/copy-icons.ts ${channel}`.env(env)

const RUST_TARGET = Bun.env.RUST_TARGET

const sidecarConfig = getCurrentSidecar(RUST_TARGET)
const rustTarget = RUST_TARGET ?? sidecarConfig.rustTarget

async function build(baseline: boolean) {
  console.log(`predev: building opencode sidecar with baseline=${baseline}`)
  const cmd = baseline
    ? $`bun run build --single --baseline --skip-install --skip-embed-web-ui`
    : $`bun run build --single --skip-install --skip-embed-web-ui`
  return cmd.cwd("../opencode").env(env).nothrow()
}

await $`bun ../../script/sync-version.ts`

function fallbackBinary(name: string) {
  return name.replace("-baseline", "")
}

// The remote web bundle does not touch packages/opencode/dist, so it can run
// concurrently with the sidecar + node builds below instead of serializing
// ~20s of vite work in front of them.
const remoteWeb = (async () => {
  if (Bun.env.SKIP_REMOTE_WEB === "1") {
    console.log("predev: SKIP_REMOTE_WEB=1, skipping remote web build")
    return null
  }
  return $`bun ./scripts/build-remote-web.ts`.env(env).nothrow()
})()

let binary = sidecarConfig.ocBinary
console.log(`predev: target sidecar binary is ${binary}`)

const baseline = sidecarConfig.ocBinary.includes("-baseline")

// On Windows, baseline bun builds are flaky due to incomplete downloads of the
// baseline executable. For dev, use the non-baseline binary which works on the
// current machine.
if (baseline && process.platform === "win32") {
  binary = fallbackBinary(binary)
  console.log(`predev: Windows dev baseline builds are flaky, using ${binary}`)
}

const shouldBuildBaseline = binary.includes("-baseline")

if (shouldBuildBaseline) {
  const result = await build(true)
  if (result.exitCode !== 0 && process.platform === "win32") {
    binary = fallbackBinary(binary)
    console.warn(`baseline sidecar build failed, falling back to ${binary}`)
    const retry = await build(false)
    if (retry.exitCode !== 0) process.exit(retry.exitCode)
  }
  if (result.exitCode !== 0 && process.platform !== "win32") process.exit(result.exitCode)
}

if (!shouldBuildBaseline) {
  const result = await build(false)
  if (result.exitCode !== 0) process.exit(result.exitCode)
}

await $`bun script/build-node.ts`.cwd("../opencode").env(env)

const web = await remoteWeb
if (web && web.exitCode !== 0) process.exit(web.exitCode)

const binaryPath = windowsify(`../opencode/dist/${binary}/bin/opencode`)

console.log(`predev: copying sidecar from ${binaryPath}`)

await copyBinaryToSidecarFolder(binaryPath, rustTarget)
