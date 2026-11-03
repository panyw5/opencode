import { describe, expect, test } from "bun:test"
import { formatExtensionList } from "../../src/cli/cmd/extension"
import type { Info } from "../../src/extension/schema"

const item = (id: string, state: Info["state"]): Info => ({
  id: id as Info["id"],
  name: id,
  version: "1.0.0",
  displayName: id,
  source: { type: "path", path: `/tmp/${id}` },
  enabled: state !== "disabled",
  state,
  activation: [],
  contributes: {},
  permissions: [],
})

describe("extension cli formatting", () => {
  test("prints stable tab separated rows", () => {
    expect(formatExtensionList([item("test.alpha", "ready"), item("test.beta", "disabled")])).toBe(
      "test.alpha\t1.0.0\tready\t/tmp/test.alpha\ntest.beta\t1.0.0\tdisabled\t/tmp/test.beta",
    )
  })
})
