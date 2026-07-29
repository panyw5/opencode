import { homedir } from "node:os"
import { join, resolve } from "node:path"

const cliDataHome = () => join(homedir(), ".local", "share")

export function sidecarDefaultCwd(userDataPath: string) {
  return join(resolve(userDataPath), "default-workspace")
}

export function desktopXdgEnv(input: {
  userDataPath: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): NodeJS.ProcessEnv {
  const env = input.env ?? process.env
  const userDataPath = resolve(input.userDataPath)

  if ((input.platform ?? process.platform) !== "win32") {
    return { XDG_STATE_HOME: env.XDG_STATE_HOME ?? userDataPath }
  }

  // Use the same default data home as the CLI so the desktop app shares the
  // session database. Cache/state remain app-private; keep global config at
  // ~/.config so CLI and desktop continue to share config files.
  //
  // Always point data to the CLI home on Windows; otherwise a stale
  // XDG_DATA_HOME (from a previous install or test setup) keeps the desktop
  // app on its own database and sessions created by the CLI won't appear.
  return {
    XDG_DATA_HOME: cliDataHome(),
    XDG_CACHE_HOME: env.XDG_CACHE_HOME ?? join(userDataPath, "cache"),
    XDG_STATE_HOME: env.XDG_STATE_HOME ?? join(userDataPath, "state"),
    ...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } : {}),
  }
}

export function sidecarDataHome(input: { userDataPath: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }) {
  // Always prefer the CLI data home on Windows so the desktop sidecar shares
  // the same database as the CLI, regardless of any inherited XDG_DATA_HOME.
  if ((input.platform ?? process.platform) === "win32") return cliDataHome()
  const env = input.env ?? process.env
  if (env.XDG_DATA_HOME) return env.XDG_DATA_HOME
  return join(homedir(), ".local", "share")
}

export function createSidecarEnv(input: {
  cwd: string
  userDataPath: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}) {
  const source = input.env ?? process.env
  const env = Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if ((input.platform ?? process.platform) === "linux") delete env.LD_PRELOAD
  Object.assign(env, desktopXdgEnv({ userDataPath: input.userDataPath, env, platform: input.platform }))
  env.PWD = input.cwd
  return env
}
