import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import path from "node:path"
import { assertPackageEntries, type PackageEntry } from "./package-content"
import { isPrunedPackagePath, packagePruningPatterns } from "./package-pruning"
import config from "../electron-builder.config"

const builderRequire = createRequire(import.meta.resolve("electron-builder"))
const { FileMatcher } = builderRequire("app-builder-lib/out/fileMatcher")
const packageRoot = path.resolve(import.meta.dirname, "..")
const pruningFilter = new FileMatcher(packageRoot, packageRoot, (value: string) => value, [
  "**/*",
  ...packagePruningPatterns,
]).createFilter()
const fileStat = { isDirectory: () => false }

function included(file: string) {
  return pruningFilter(path.join(packageRoot, file), fileStat)
}

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

test("pruning filters and package audit agree for top-level and nested dependencies", () => {
  for (const file of [
    "node_modules/openai/index.d.ts",
    "node_modules/venice-ai-sdk-provider/dist/index.d.mts",
    "node_modules/drizzle-orm/index.d.cts",
    "node_modules/@ai-sdk/google-vertex/src/index.ts",
    "node_modules/@ai-sdk/amazon-bedrock/node_modules/@ai-sdk/openai/src/index.ts",
    "node_modules/@ai-sdk/groq/node_modules/@ai-sdk/openai/src/transcription/transcription-test.mp3",
    "node_modules/@anthropic-ai/sdk/src/index.ts",
    "node_modules/ai-gateway-provider/src/index.ts",
    "node_modules/venice-ai-sdk-provider/src/index.ts",
    "node_modules/@opencode-ai/core/node_modules/zod/index.js",
    "node_modules/@opencode-ai/core/node_modules/@ai-sdk/google/dist/index.js",
  ]) {
    expect(isPrunedPackagePath(file)).toBe(true)
    expect(included(file)).toBe(false)
    expect(() => assertPackageEntries([...runtime, { path: file, size: 1 }])).toThrow("Redundant")
  }
  for (const pattern of packagePruningPatterns) expect(config.files).toContain(pattern)
})

test("pruning preserves JS entry points, dynamic runtime files, licenses and source exports", () => {
  for (const file of [
    "node_modules/openai/index.js",
    "node_modules/openai/index.mjs",
    "node_modules/@ai-sdk/openai/dist/index.js",
    "node_modules/@ai-sdk/openai/LICENSE",
    "node_modules/@ai-sdk/amazon-bedrock/node_modules/@ai-sdk/openai/dist/index.mjs",
    "node_modules/@opencode-ai/core/package.json",
    "node_modules/zod/src/index.ts",
    "node_modules/zod/src/v4/index.ts",
    "node_modules/protobufjs/src/index.js",
    "node_modules/ajv/dist/runtime/parseJson.js",
    "node_modules/fast-json-stringify/lib/serializer.js",
    "node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/pty.node",
    "node_modules/source-only-library/src/index.ts",
    "out/main/chunks/index.d.ts",
  ]) {
    expect(isPrunedPackagePath(file)).toBe(false)
    expect(included(file)).toBe(true)
    expect(() => assertPackageEntries([...runtime, { path: file, size: 1 }])).not.toThrow()
  }
})
