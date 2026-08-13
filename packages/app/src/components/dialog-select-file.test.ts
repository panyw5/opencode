import { describe, expect, test } from "bun:test"
import type { CommandOption } from "@/context/command"
import { pickCommandOptions } from "./dialog-select-file-utils"

const command = (id: string): CommandOption => ({ id, title: id })

describe("pickCommandOptions", () => {
  test("uses the requested order for home commands", () => {
    const options = [
      command("session.previous"),
      command("app.reloadFrontend"),
      command("session.next"),
      command("server.reloadBackend"),
    ]

    const result = pickCommandOptions(options, ["server.reloadBackend", "app.reloadFrontend"])

    expect(result.map((item) => item.id)).toEqual(["server.reloadBackend", "app.reloadFrontend"])
  })
})
