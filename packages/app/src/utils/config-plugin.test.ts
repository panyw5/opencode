import { expect, test } from "bun:test"
import { configPluginKey, pluginKey, relativePluginSpecifier, updatePluginEntries } from "./config-plugin"

const configPath = "/Users/me/project/.opencode/opencode.jsonc"
const pluginPath = "/Users/me/project/.opencode/plugins/latex-format.mjs"

test("matches a project config relative plugin path to its scanned file", () => {
  expect(configPluginKey("./plugins/latex-format.mjs", configPath)).toBe(pluginKey(pluginPath))
})

test("keeps relative plugin config entries when enabling an existing plugin", () => {
  expect(
    updatePluginEntries({
      entries: ["./plugins/latex-format.mjs"],
      configPath,
      key: pluginKey(pluginPath),
      nextSpecifier: relativePluginSpecifier(pluginPath, configPath),
      enabled: true,
    }),
  ).toEqual(["./plugins/latex-format.mjs"])
})

test("removes the matching relative plugin config entry when disabling", () => {
  expect(
    updatePluginEntries({
      entries: ["./plugins/latex-format.mjs", "other-plugin"],
      configPath,
      key: pluginKey(pluginPath),
      nextSpecifier: relativePluginSpecifier(pluginPath, configPath),
      enabled: false,
    }),
  ).toEqual(["other-plugin"])
})
