import path from "node:path"
import solid from "vite-plugin-solid"
import { SHARED_EXPORTS, sharedShim } from "./shims.js"

const virtualPrefix = "\0opencode:extension-host:"

/**
 * @typedef {{ entry?: string; outDir?: string }} ExtensionKitOptions
 */

/**
 * Build an OpenCode web extension against the host's shared Solid/UI runtime.
 *
 * @param {ExtensionKitOptions} [options]
 * @returns {import("vite").PluginOption[]}
 */
export default function extensionKit(options = {}) {
  const entry = path.resolve(process.cwd(), options.entry ?? "src/web.tsx")
  const outDir = path.resolve(process.cwd(), options.outDir ?? "dist/web")

  /** @type {import("vite").Plugin} */
  const hostModules = {
    name: "opencode:extension-host-modules",
    enforce: "pre",
    config() {
      return {
        build: {
          target: "esnext",
          outDir,
          emptyOutDir: true,
          cssCodeSplit: false,
          lib: {
            entry,
            formats: ["es"],
            fileName: () => "index.js",
          },
          rollupOptions: {
            output: {
              entryFileNames: "index.js",
              chunkFileNames: "[name]-[hash].js",
              assetFileNames: (asset) => (asset.name?.endsWith(".css") ? "index.css" : "assets/[name]-[hash][extname]"),
            },
          },
        },
      }
    },
    resolveId(id) {
      if (id in SHARED_EXPORTS) return `${virtualPrefix}${id}`
      if (id.startsWith("solid-js/") || id.startsWith("@opencode-ai/ui/")) {
        throw new Error(`OpenCode extension imports unsupported host module: ${id}`)
      }
    },
    load(id) {
      if (!id.startsWith(virtualPrefix)) return
      return sharedShim(id.slice(virtualPrefix.length))
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue
        const bare = /(?:\bfrom\s*["'](?:solid-js(?:\/[^"']*)?|@opencode-ai\/ui\/[^"']+)["']|\bimport\s*["'](?:solid-js(?:\/[^"']*)?|@opencode-ai\/ui\/[^"']+)["']|\bimport\s*\(\s*["'](?:solid-js(?:\/[^"']*)?|@opencode-ai\/ui\/[^"']+)["']\s*\))/.exec(
          output.code,
        )
        if (!bare) continue
        throw new Error(`OpenCode extension output contains an unresolved host import: ${bare[0]}`)
      }
    },
  }

  return [hostModules, solid()]
}
