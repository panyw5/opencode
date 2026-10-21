import { expect, test } from "bun:test"
import { assertPackageEntries, type PackageEntry } from "./package-content"
import config from "../electron-builder.config"

const runtime = [
  "out/main/index.js",
  "out/main/sidecar.js",
  "out/main/remote-worker.js",
  "out/preload/index.js",
  "node_modules/effect/dist/Effect.js",
  "node_modules/effect/LICENSE",
].map((path) => ({ path, size: 1 }))

test("package audit keeps runtime entry points, Effect runtime and licenses", () => {
  expect(() => assertPackageEntries(runtime)).not.toThrow()
  for (const path of runtime.map((entry) => entry.path))
    expect(() => assertPackageEntries(runtime.filter((entry) => entry.path !== path))).toThrow()
  expect(typeof config.afterPack).toBe("function")
})

test("package audit rejects bundled dependency copies and unused source trees", () => {
  for (const path of [
    "node_modules/@opencode-ai/core/src/index.ts",
    "node_modules/@opencode-ai/util/src/path.ts",
    "node_modules/@opencode-ai/remote-tunnel/src/index.ts",
    "node_modules/@opencode-ai/remote-tunnel/node_modules/effect/dist/Effect.js",
    "node_modules/@opentunnel/client/dist/index.js",
    "node_modules/@opentunnel/protocol/src/index.ts",
    "node_modules/effect/src/Effect.ts",
    "node_modules/effect/ai-docs/README.md",
  ])
    expect(() => assertPackageEntries([...runtime, { path, size: 1 }])).toThrow("Redundant")
})

test("source pruning is scoped, not a blanket deletion of dependency src directories", () => {
  const needed: PackageEntry[] = [
    { path: "node_modules/protobufjs/src/index.js", size: 1 },
    { path: "node_modules/@opentunnel/client/LICENSE", size: 1 },
  ]
  expect(() => assertPackageEntries([...runtime, ...needed])).not.toThrow()
  expect(config.files).not.toContain("!**/src/**/*")
})
