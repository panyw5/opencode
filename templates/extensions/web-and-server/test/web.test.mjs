import { readFileSync } from "node:fs"
import assert from "node:assert/strict"
import test from "node:test"
import web from "../src/web.js"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

test("web entry declares the manifest id and host api version", () => {
  assert.equal(web.id, pkg.opencode.id)
  assert.equal(web.apiVersion, 1)
  assert.equal(typeof web.activate, "function")
})

test("activate registers the declared file viewer contribution", async () => {
  const registrations = []
  const context = {
    fileViewers: { register: (contribution) => registrations.push(["fileViewers", contribution]) },
    toolRenderers: { register: (contribution) => registrations.push(["toolRenderers", contribution]) },
    panels: { register: (contribution) => registrations.push(["panels", contribution]) },
    commands: { register: (contribution) => registrations.push(["commands", contribution]) },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  }
  await web.activate(context)
  assert.deepEqual(
    registrations.map(([kind, contribution]) => [kind, contribution.id]),
    pkg.opencode.contributes.fileViewers.map((viewer) => ["fileViewers", viewer.id]),
  )
  assert.equal(typeof registrations[0][1].component, "function")
})
