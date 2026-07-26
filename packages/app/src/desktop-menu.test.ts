import { expect, test } from "bun:test"

import { DESKTOP_MENU } from "./desktop-menu"

test("macOS reserves Cmd+W for closing tabs", () => {
  const fileMenu = DESKTOP_MENU.find((menu) => menu.id === "file")
  const closeTab = fileMenu?.items?.find((item) => item.type === "item" && item.command === "sessionTabs.close")
  const closeWindow = fileMenu?.items?.find((item) => item.type === "item" && item.action === "window.close")

  expect(closeTab).toMatchObject({
    accelerator: { macos: "Cmd+W" },
    platforms: ["macos"],
  })
  expect(closeWindow).toMatchObject({
    accelerator: { macos: "Cmd+Shift+W" },
  })
  expect(closeWindow).not.toMatchObject({ role: "close" })
})
