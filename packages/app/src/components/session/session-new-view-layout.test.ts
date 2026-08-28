import { describe, expect, test } from "bun:test"
import {
  sessionNewCanOpenFolder,
  sessionNewMeta,
  sessionNewOpenFolderKey,
  sessionNewOpenFolderVia,
  sessionNewPane,
} from "./session-new-view-layout"

describe("session new layout", () => {
  test("keeps regular projects aligned with session content width", () => {
    expect(sessionNewMeta(false)).toBe("md:max-w-[var(--session-content-width)] md:mx-auto")
  })

  test("keeps extra agents on wide layout", () => {
    expect(sessionNewMeta(true)).toBe("")
  })

  test("expands extra agent pane by viewport width", () => {
    expect(sessionNewPane(1200)).toBe("64rem")
    expect(sessionNewPane(1300)).toBe("72rem")
    expect(sessionNewPane(1600)).toBe("80rem")
    expect(sessionNewPane(1900)).toBe("88rem")
    expect(sessionNewPane(2300)).toBe("96rem")
  })

  test("uses Finder on macOS and File Explorer on Windows", () => {
    expect(sessionNewOpenFolderKey("macos")).toBe("command.project.openInFinder")
    expect(sessionNewOpenFolderKey("windows")).toBe("command.project.openInFileExplorer")
    expect(sessionNewOpenFolderKey("linux")).toBe("command.project.openInFileManager")
    expect(sessionNewOpenFolderVia("macos")).toBe("openInFinder")
    expect(sessionNewOpenFolderVia("windows")).toBe("openPath")
  })

  test("only opens folders in the local desktop app", () => {
    expect(
      sessionNewCanOpenFolder({
        platform: "desktop",
        os: "macos",
        local: true,
        openInFinder: true,
      }),
    ).toBe(true)
    expect(
      sessionNewCanOpenFolder({
        platform: "desktop",
        os: "windows",
        local: true,
        openPath: true,
      }),
    ).toBe(true)
    expect(
      sessionNewCanOpenFolder({
        platform: "web",
        os: "macos",
        local: true,
        openInFinder: true,
      }),
    ).toBe(false)
    expect(
      sessionNewCanOpenFolder({
        platform: "desktop",
        os: "macos",
        local: false,
        openInFinder: true,
      }),
    ).toBe(false)
  })
})
