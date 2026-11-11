import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const host = readFileSync(new URL("./host.tsx", import.meta.url), "utf8")
const drop = readFileSync(new URL("../pages/config-extension-archive-drop.tsx", import.meta.url), "utf8")

test("a changed connection resets retry state before new manifest requests", () => {
  const start = host.indexOf("if (activeServerURL !== scope.url || activeClient !== scope.client)")
  const end = host.indexOf("const previousCleanup", start)
  const changed = host.slice(start, end)
  expect(changed).toContain("clearTimeout(refreshRetry)")
  expect(changed).toContain("refreshRetry = undefined")
  expect(changed).toContain("refreshFailures = 0")
  expect(changed).toContain("setListError(false)")
  expect(end).toBeLessThan(host.indexOf("const list = await api.list()", start))
})

test("drop handler is registered regardless of initial connection and gates every drop", () => {
  const mount = drop.slice(drop.indexOf("onMount(() =>"), drop.indexOf("registerArchiveDropHandler((paths)"))
  expect(mount).not.toContain("if (!supported()) return")
  expect(drop).toContain("if (!supported() || paths.length === 0")
  expect(drop).toContain("onCleanup(unregister)")
})

test("desktop release preparations keep the desktop cancellation owner", () => {
  const start = host.indexOf("const connection = {", host.indexOf("const prepareInstallation = async"))
  const connection = host.slice(start, host.indexOf("const release = beginMutation", start))
  expect(connection).toContain('request.source?.type === "release"')
  expect(connection).toContain('request.target === "release-current"')
})
