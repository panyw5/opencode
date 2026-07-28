import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { createSidecarEnv, desktopXdgEnv, sidecarDataHome, sidecarDefaultCwd } from "./server-env"

describe("sidecar environment", () => {
  test("uses an app-private default workspace instead of the process cwd", () => {
    const userDataPath = "/tmp/opencode-user-data"

    expect(sidecarDefaultCwd(userDataPath)).toBe(join(resolve(userDataPath), "default-workspace"))
  })

  test("sets PWD to the sidecar cwd and removes debug-only inherited variables", () => {
    const env = createSidecarEnv({
      cwd: "/tmp/opencode-user-data/default-workspace",
      userDataPath: "/tmp/opencode-user-data",
      platform: "linux",
      env: {
        DEBUG: "1",
        LD_PRELOAD: "/tmp/hook.so",
        PATH: "/usr/bin",
        PWD: "/Users/example",
      },
    })

    expect(env.PWD).toBe("/tmp/opencode-user-data/default-workspace")
    expect(env.PATH).toBe("/usr/bin")
    expect(env.DEBUG).toBeUndefined()
    expect(env.LD_PRELOAD).toBeUndefined()
  })

  test("keeps the global config path on Windows while isolating desktop state", () => {
    const userDataPath = "C:\\Users\\Ada\\AppData\\Roaming\\ai.opencode.desktop"
    const paths = desktopXdgEnv({ userDataPath, platform: "win32", env: {} })

    expect(paths.XDG_DATA_HOME).toBe(join(resolve(userDataPath), "data"))
    expect(paths.XDG_CONFIG_HOME).toBeUndefined()
    expect(paths.XDG_CACHE_HOME).toBe(join(resolve(userDataPath), "cache"))
    expect(paths.XDG_STATE_HOME).toBe(join(resolve(userDataPath), "state"))
    expect(sidecarDataHome({ userDataPath, platform: "win32", env: {} })).toBe(paths.XDG_DATA_HOME)
  })

  test("preserves explicit XDG overrides", () => {
    const env = desktopXdgEnv({
      userDataPath: "/tmp/opencode-user-data",
      platform: "win32",
      env: {
        XDG_DATA_HOME: "D:\\OpenCodeData",
        XDG_CONFIG_HOME: "D:\\OpenCodeConfig",
      },
    })

    expect(env.XDG_DATA_HOME).toBe("D:\\OpenCodeData")
    expect(env.XDG_CONFIG_HOME).toBe("D:\\OpenCodeConfig")
    expect(env.XDG_CACHE_HOME).toBe(join(resolve("/tmp/opencode-user-data"), "cache"))
    expect(sidecarDataHome({ userDataPath: "/tmp/opencode-user-data", platform: "win32", env })).toBe(
      "D:\\OpenCodeData",
    )
  })

  test("keeps the existing XDG data fallback outside Windows", () => {
    expect(sidecarDataHome({ userDataPath: "/tmp/opencode-user-data", platform: "darwin", env: {} })).toBe(
      join(homedir(), ".local", "share"),
    )
  })
})
