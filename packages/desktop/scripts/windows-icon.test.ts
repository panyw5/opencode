import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import config from "../electron-builder.config"

test("Windows packaging uses the transparent icon without changing macOS", () => {
  expect(config.win?.icon).toBe("resources/icons/windows.ico")
  expect(config.nsis?.installerIcon).toBe(config.win?.icon)
  expect(config.nsis?.installerHeaderIcon).toBe(config.win?.icon)
  expect(config.nsis?.uninstallerIcon).toBe(config.win?.icon)
  expect(config.mac?.icon).toBe("resources/icons/icon.icns")
})

test("Windows icon includes 32-bit images for small and large system surfaces", async () => {
  const ico = await readFile(new URL("../icons/windows/icon.ico", import.meta.url))
  expect(ico.readUInt16LE(0)).toBe(0)
  expect(ico.readUInt16LE(2)).toBe(1)
  const count = ico.readUInt16LE(4)
  const sizes: number[] = []
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16
    const width = ico[offset] || 256
    expect(ico[offset + 1] || 256).toBe(width)
    expect(ico.readUInt16LE(offset + 6)).toBe(32)
    expect(ico.readUInt32LE(offset + 12) + ico.readUInt32LE(offset + 8)).toBeLessThanOrEqual(ico.length)
    sizes.push(width)
  }
  expect(sizes.sort((a, b) => a - b)).toEqual([16, 24, 32, 48, 64, 128, 256])
})
