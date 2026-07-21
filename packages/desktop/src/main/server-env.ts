import { homedir } from "node:os"
import { join, resolve } from "node:path"

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

  return {
    XDG_DATA_HOME: env.XDG_DATA_HOME ?? join(userDataPath, "data"),
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME ?? join(userDataPath, "config"),
    XDG_CACHE_HOME: env.XDG_CACHE_HOME ?? join(userDataPath, "cache"),
    XDG_STATE_HOME: env.XDG_STATE_HOME ?? join(userDataPath, "state"),
  }
}

export function sidecarDataHome(input: { userDataPath: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }) {
  const env = input.env ?? process.env
  if (env.XDG_DATA_HOME) return env.XDG_DATA_HOME
  if ((input.platform ?? process.platform) === "win32") return join(resolve(input.userDataPath), "data")
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
