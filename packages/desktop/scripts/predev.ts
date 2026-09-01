import { $ } from "bun"
import { getCurrentSidecar, windowsify, copyBinaryToSidecarFolder } from "./utils"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

const RUST_TARGET = Bun.env.RUST_TARGET

const sidecarConfig = getCurrentSidecar(RUST_TARGET)
const rustTarget = RUST_TARGET ?? sidecarConfig.rustTarget

async function build(baseline: boolean) {
  console.log(`predev: building opencode sidecar with baseline=${baseline}`)
  const cmd = baseline
    ? $`bun run build --single --baseline --skip-install --skip-embed-web-ui`
    : $`bun run build --single --skip-install --skip-embed-web-ui`
  return cmd.cwd("../opencode").nothrow()
}

await $`bun ../../script/sync-version.ts`

function fallbackBinary(name: string) {
  return name.replace("-baseline", "")
}

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

await $`bun script/build-node.ts`
  .cwd("../opencode")
  .env({ ...Bun.env, OPENCODE_CHANNEL: "local" })

const binaryPath = windowsify(`../opencode/dist/${binary}/bin/opencode`)

console.log(`predev: copying sidecar from ${binaryPath}`)

await copyBinaryToSidecarFolder(binaryPath, rustTarget)
