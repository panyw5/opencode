import { describe, expect, test } from "bun:test"
import type { CommandOption } from "@/context/command"
import { HOME_COMMAND_IDS, NEW_SESSION_COMMAND_IDS, pickCommandOptions } from "./dialog-select-file-utils"

const command = (id: string): CommandOption => ({ id, title: id })

describe("pickCommandOptions", () => {
  test("prioritizes recent sessions and omits new session on the new session page", () => {
    const options = [
      command("terminal.toggle"),
      command("session.next"),
      command("session.new"),
      command("session.recent"),
      command("session.previous"),
    ]

    const result = pickCommandOptions(options, NEW_SESSION_COMMAND_IDS)

    expect(result.map((item) => item.id)).toEqual([
      "session.recent",
      "session.previous",
      "session.next",
      "terminal.toggle",
    ])
    expect(result.map((item) => item.id)).not.toContain("session.new")
  })

  test("uses the requested order for home commands", () => {
    const options = [
      command("session.previous"),
      command("app.reloadFrontend"),
      command("session.next"),
      command("server.reloadBackend"),
      command("session.recent"),
      command("project.open"),
      command("settings.open"),
    ]

    const result = pickCommandOptions(options, HOME_COMMAND_IDS)

    expect(result.map((item) => item.id)).toEqual([
      "session.recent",
      "project.open",
      "settings.open",
      "server.reloadBackend",
      "app.reloadFrontend",
    ])
    expect(result.map((item) => item.id).indexOf("session.recent")).toBeLessThan(
      result.map((item) => item.id).indexOf("server.reloadBackend"),
    )
    expect(result.map((item) => item.id).indexOf("session.recent")).toBeLessThan(
      result.map((item) => item.id).indexOf("app.reloadFrontend"),
    )
    expect(result.map((item) => item.id)).not.toContain("session.previous")
    expect(result.map((item) => item.id)).not.toContain("session.next")
  })
})
