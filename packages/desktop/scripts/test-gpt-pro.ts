import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gptProTestMode, gptProTestSuites } from "./gpt-pro-test-suite"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const desktop = resolve(root, "packages/desktop")
const mode = gptProTestMode(process.argv.slice(2))
const run = async (args: string[], cwd = desktop) => {
  const child = Bun.spawn(args, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const status = await child.exited
  if (status) throw Error(`GPT-Pro test command failed with exit code ${status}`)
}

if (mode === "help") {
  console.info(
    "GPT-Pro tests: --unit (default), --list, --baseline, --native, --logged-out, --live, --live-rich, --live-multipage",
  )
  console.info(
    "Default runs package-isolated tests only. Native uses offline synthetic pages. CDP modes require an already running dev app.",
  )
  console.info(
    "Live modes send isolated real consultations only after authorized development login; they never log in or change settings.",
  )
} else if (mode === "unit" || mode === "list") {
  for (const suite of await gptProTestSuites(root)) {
    console.info(`[gpt-pro-suite] ${suite.name} files=${suite.files.length}`)
    if (mode === "list") {
      if (suite.filter) console.info(`  test-name-pattern=${suite.filter}`)
      for (const file of suite.files) console.info(`  packages/${suite.package}/${file}`)
    } else
      await run(
        [
          process.execPath,
          "test",
          ...suite.preload,
          ...(suite.filter ? ["--test-name-pattern", suite.filter] : []),
          ...suite.files.map((file) => `./${file}`),
        ],
        suite.directory,
      )
  }
} else if (mode === "native") {
  await run([
    process.execPath,
    "build",
    "scripts/gpt-pro-profile-native-e2e.ts",
    "--target=node",
    "--format=cjs",
    "--external",
    "electron",
    "--external",
    "electron-log",
    "--external",
    "electron-log/main.js",
    "--outfile=out/gpt-pro-profile-native-e2e.cjs",
  ])
  const electron = process.platform === "win32" ? "node_modules/.bin/electron.cmd" : "node_modules/.bin/electron"
  await run([resolve(desktop, electron), "out/gpt-pro-profile-native-e2e.cjs"])
} else {
  const scripts = {
    baseline: ["gpt-pro-session-baseline.ts"],
    "logged-out": ["gpt-pro-login-regression-e2e.ts"],
    live: ["gpt-pro-auth-state-e2e.ts"],
    "live-rich": ["gpt-pro-auth-state-e2e.ts", "--rich"],
    "live-multipage": ["gpt-pro-multipage-e2e.ts"],
  }
  const [script, ...args] = scripts[mode]
  await run([process.execPath, `scripts/${script}`, ...args])
}
