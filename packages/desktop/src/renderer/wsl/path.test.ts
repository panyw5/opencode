import { describe, expect, test } from "bun:test"

import { convertWslPath } from "./path"

describe("WSL path conversion", () => {
  test("returns the converted path", async () => {
    await expect(
      convertWslPath({
        path: "C:\\Users\\Ada\\project",
        mode: "linux",
        convert: async () => "/mnt/c/Users/Ada/project",
      }),
    ).resolves.toBe("/mnt/c/Users/Ada/project")
  })

  test("reports conversion failures instead of returning the incompatible source path", async () => {
    await expect(
      convertWslPath({
        path: "C:\\Users\\Ada\\project",
        mode: "linux",
        convert: async () => {
          throw new Error("Ubuntu is not running")
        },
      }),
    ).rejects.toThrow("Could not convert C:\\Users\\Ada\\project to a linux path for WSL: Ubuntu is not running")
  })

  test("rejects empty conversion results", async () => {
    await expect(
      convertWslPath({
        path: "/home/ada/project",
        mode: "windows",
        convert: async () => "",
      }),
    ).rejects.toThrow("wslpath returned an empty path")
  })
})
