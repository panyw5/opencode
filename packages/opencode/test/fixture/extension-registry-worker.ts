import path from "node:path"

const [registry, directory] = process.argv.slice(2)
if (!registry || !directory) throw new Error("usage: extension-registry-worker <registry> <directory>")

const { ExtensionRegistry } = await import("../../src/extension/registry")
await ExtensionRegistry.link(path.resolve(directory), undefined, path.resolve(registry))
