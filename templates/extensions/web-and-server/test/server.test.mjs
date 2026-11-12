import { readFileSync } from "node:fs"
import assert from "node:assert/strict"
import test from "node:test"
import extension from "../src/server.js"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

test("extension identity follows package metadata", () => {
  assert.equal(extension.id, pkg.opencode.id)
  assert.equal(pkg.exports["./server"], "./src/server.js")
  assert.equal(pkg.exports["./web"], "./src/web.js")
  assert.equal(pkg.opencode.web.apiVersion, 1)
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.workspaces, undefined)
})

test("ping returns the host version without cross-activation state", async () => {
  const first = await extension.activate({ version: pkg.version })
  const second = await extension.activate({ version: "2.0.0" })
  assert.deepEqual(await first.rpc.ping(), { version: pkg.version, message: "web-extension-starter-ok" })
  assert.deepEqual(await second.rpc.ping(), { version: "2.0.0", message: "web-extension-starter-ok" })
  assert.deepEqual(await first.rpc.ping(), { version: pkg.version, message: "web-extension-starter-ok" })
})
