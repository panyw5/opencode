import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

import {
  attachmentExtension,
  cliInstallDirectory,
  configRoot,
  resolveDesktopPath,
  tempMarkdownAttachmentPath,
  trellisTaskFolderName,
} from "./native-path"

describe("native desktop paths", () => {
  test("resolves the config root using core-compatible override precedence", () => {
    const home = "/home/ada"
    expect(configRoot({ home, env: {} })).toBe("/home/ada/.config/opencode")
    expect(configRoot({ home, env: { XDG_CONFIG_HOME: "/data/config" } })).toBe("/data/config/opencode")
    expect(
      configRoot({
        home,
        env: { OPENCODE_CONFIG_DIR: "~/custom-opencode", XDG_CONFIG_HOME: "/data/config" },
      }),
    ).toBe("/home/ada/custom-opencode")
  })

  test("uses LOCALAPPDATA for the Windows CLI install location", () => {
    expect(
      cliInstallDirectory({
        platform: "win32",
        home: "/home/ada",
        env: { LOCALAPPDATA: "D:/OpenCodeLocal" },
      }),
    ).toBe("D:/OpenCodeLocal/opencode/bin")
    expect(cliInstallDirectory({ platform: "win32", home: "/home/ada", env: {} })).toBe(
      "/home/ada/AppData/Local/opencode/bin",
    )
  })

  test("expands home aliases before resolving paths", () => {
    expect(resolveDesktopPath("~")).toBe(resolve(homedir()))
    expect(resolveDesktopPath("~/")).toBe(resolve(homedir()))
    expect(resolveDesktopPath("~/Documents")).toBe(resolve(homedir(), "Documents"))
    expect(resolveDesktopPath("~\\Documents")).toBe(resolve(homedir(), "Documents"))
  })

  test("leaves normal paths on the standard resolver path", () => {
    expect(resolveDesktopPath("/tmp/example")).toBe(resolve("/tmp/example"))
    expect(resolveDesktopPath("relative/example")).toBe(resolve("relative/example"))
    expect(resolveDesktopPath(join("/tmp", "space dir"))).toBe(resolve("/tmp", "space dir"))
  })

  test("builds project-scoped temporary markdown attachment paths", () => {
    const root = join("/tmp", "opencode-md-attachment")
    const path = tempMarkdownAttachmentPath(root, {
      id: "abcdef12",
      now: new Date("2026-06-22T09:30:15.123Z"),
    })

    expect(path.startsWith(join(root, ".opencode", "tmp", "attachments"))).toBe(true)
    expect(path.endsWith(join(".opencode", "tmp", "attachments", "prompt-2026-06-22T09-30-15-123Z-abcdef12.md"))).toBe(
      true,
    )
  })

  test("builds temporary attachment paths with custom extensions", () => {
    const root = join("/tmp", "opencode-md-attachment")
    const path = tempMarkdownAttachmentPath(root, {
      id: "abcdef12",
      now: new Date("2026-06-22T09:30:15.123Z"),
      extension: ".txt",
    })

    expect(path.endsWith(join(".opencode", "tmp", "attachments", "prompt-2026-06-22T09-30-15-123Z-abcdef12.txt"))).toBe(
      true,
    )
  })

  test("sanitizes temporary attachment extensions", () => {
    expect(attachmentExtension("ts")).toBe("ts")
    expect(attachmentExtension(".json")).toBe("json")
    expect(attachmentExtension("")).toBe("md")
    expect(attachmentExtension("../sh")).toBe("md")
  })
})

describe("trellis tasks", () => {
  test("keeps user-readable task folder names", () => {
    expect(trellisTaskFolderName("My Task")).toBe("My Task")
  })

  test("sanitizes task folder names", () => {
    expect(trellisTaskFolderName("../Bad/Name")).toBe("Bad-Name")
    expect(trellisTaskFolderName("task: invalid/name")).toBe("task- invalid-name")
    expect(() => trellisTaskFolderName("../")).toThrow("valid folder name")
    expect(() => trellisTaskFolderName("archive")).toThrow("archive")
  })
})
