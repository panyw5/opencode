import { homedir } from "node:os"
import { join, resolve } from "node:path"

const cliDataHome = () => join(homedir(), ".local", "share")

export type DesktopStartupPaths = {
  sidecarDataHome: string
  cacheHome: string
  stateHome: string
  sidecarEnv: NodeJS.ProcessEnv
  defaultWorkspaceCwd: string
}

/** Resolves all desktop-owned paths before the sidecar is launched. */
export function resolveDesktopStartupPaths(input: {
  userDataPath: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  cwd?: string
}): DesktopStartupPaths {
  const env = input.env ?? process.env
  const userDataPath = resolve(input.userDataPath)
  const defaultWorkspaceCwd = input.cwd ?? join(userDataPath, "default-workspace")

  if ((input.platform ?? process.platform) !== "win32") {
    return {
      sidecarDataHome: env.XDG_DATA_HOME ?? cliDataHome(),
      cacheHome: env.XDG_CACHE_HOME ?? join(userDataPath, "cache"),
      stateHome: env.XDG_STATE_HOME ?? userDataPath,
      sidecarEnv: { XDG_STATE_HOME: env.XDG_STATE_HOME ?? userDataPath },
      defaultWorkspaceCwd,
    }
  }

  // Use the same default data home as the CLI so the desktop app shares the
  // session database. Cache/state remain app-private; keep global config at
  // ~/.config so CLI and desktop continue to share config files.
  //
  // Honor an explicit CLI data-home override. This keeps desktop, the CLI,
  // and isolated onboarding runs on the same persistent-data location.
  const sidecarDataHome = env.XDG_DATA_HOME ?? cliDataHome()
  const cacheHome = env.XDG_CACHE_HOME ?? join(userDataPath, "cache")
  const stateHome = env.XDG_STATE_HOME ?? join(userDataPath, "state")
  return {
    sidecarDataHome,
    cacheHome,
    stateHome,
    sidecarEnv: {
      XDG_DATA_HOME: sidecarDataHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_STATE_HOME: stateHome,
      ...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } : {}),
    },
    defaultWorkspaceCwd,
  }
}

export function sidecarDefaultCwd(userDataPath: string) {
  return resolveDesktopStartupPaths({ userDataPath }).defaultWorkspaceCwd
}

export function desktopXdgEnv(input: {
  userDataPath: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): NodeJS.ProcessEnv {
  return resolveDesktopStartupPaths(input).sidecarEnv
}

export function sidecarDataHome(input: { userDataPath: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }) {
  // Keep this test-facing helper aligned with the single startup-path policy.
  return resolveDesktopStartupPaths(input).sidecarDataHome
}

export function createSidecarEnv(input: {
  cwd: string
  paths: DesktopStartupPaths
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}) {
  const source = input.env ?? process.env
  const env = Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if ((input.platform ?? process.platform) === "linux") delete env.LD_PRELOAD
  Object.assign(env, input.paths.sidecarEnv)
  env.PWD = input.cwd
  return env
}
