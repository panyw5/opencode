import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isShareableRendererAsset } from "../src/main/shared-renderer-assets"
import { findSharedRendererAssets } from "./shared-renderer-assets"

test("shares only identical regular font and image files at the same asset URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shared-renderer-assets-"))
  const renderer = join(dir, "renderer")
  const remote = join(dir, "remote")
  try {
    expect(findSharedRendererAssets(renderer, remote)).toEqual([])
    await Promise.all([renderer, remote].map((root) => mkdir(join(root, "assets"), { recursive: true })))
    for (const name of ["font.woff2", "icon.svg", "changed.png", "script.js", "local.gif", "link.svg"]) {
      await writeFile(join(renderer, "assets", name), "aaa")
    }
    for (const name of ["font.woff2", "icon.svg", "changed.png", "script.js", "other.gif"]) {
      await writeFile(join(remote, "assets", name), name === "changed.png" ? "bbb" : "aaa")
    }
    await symlink("icon.svg", join(remote, "assets", "link.svg"))
    expect(findSharedRendererAssets(renderer, remote)).toEqual(["assets/font.woff2", "assets/icon.svg"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("restricts the renderer's shared route to flat static asset paths", () => {
  expect(isShareableRendererAsset("assets/font-Abc_123.woff2")).toBe(true)
  for (const path of [
    "index.html",
    "assets/script.js",
    "assets/a/../font.woff2",
    "assets/..\\font.woff2",
    "//assets/icon.svg",
  ]) {
    expect(isShareableRendererAsset(path)).toBe(false)
  }
})
