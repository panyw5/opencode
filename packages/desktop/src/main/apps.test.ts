import { describe, expect, test } from "bun:test"
import { getAppLaunchPlan, getPowerShellLauncherArgs } from "./apps"

describe("getAppLaunchPlan", () => {
  test("launches Windows PowerShell detached in the requested directory", () => {
    expect(getAppLaunchPlan("D:\\work folder\\project", "powershell.exe", "win32")).toEqual({
      mode: "powershell",
      command: "powershell.exe",
      cwd: "D:\\work folder\\project",
    })
  })

  test("recognizes resolved PowerShell executable paths case-insensitively", () => {
    expect(
      getAppLaunchPlan(
        "D:\\project",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE",
        "win32",
      ),
    ).toMatchObject({ mode: "powershell", cwd: "D:\\project" })
  })

  test("encodes safe Start-Process arguments for paths containing spaces and apostrophes", () => {
    const args = getPowerShellLauncherArgs("C:\\Program Files\\PowerShell\\pwsh.exe", "D:\\team's work")
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
    expect(Buffer.from(args[4], "base64").toString("utf16le")).toBe(
      "$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'C:\\Program Files\\PowerShell\\pwsh.exe' -ArgumentList @('-NoExit') -WorkingDirectory 'D:\\team''s work'",
    )
  })

  test("passes the path as an argument to regular Windows applications", () => {
    expect(getAppLaunchPlan("D:\\project", "code.exe", "win32")).toEqual({
      mode: "wait",
      command: "code.exe",
      args: ["D:\\project"],
    })
  })

  test("uses macOS open for named applications", () => {
    expect(getAppLaunchPlan("/tmp/project", "Terminal", "darwin")).toEqual({
      mode: "wait",
      command: "open",
      args: ["-a", "Terminal", "/tmp/project"],
    })
  })
})
