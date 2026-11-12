import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { SHARED_EXPORTS, sharedShim } from "./shims.js"
import { extensionScopePostcssPlugin, scopeExtensionID } from "./scope.js"

const virtualPrefix = "\0opencode:extension-host:"

// The build stamp must record the solid-js the extension is compiled
// against, so resolve the extension's own install first and only then fall
// back to the kit's. Returns undefined when solid-js cannot be resolved;
// the caller warns and skips the stamp instead of writing a wrong version.
function resolveSolidVersion(baseDir) {
  for (const base of [path.join(baseDir, "package.json"), fileURLToPath(import.meta.url)]) {
    try {
      const pkg = createRequire(base).resolve("solid-js/package.json")
      const { version } = JSON.parse(fs.readFileSync(pkg, "utf8"))
      if (typeof version === "string" && version) return version
    } catch {
      // Try the next resolution base.
    }
  }
  return undefined
}

/**
 * @typedef {{ entry?: string; outDir?: string; scope?: string }} ExtensionKitOptions
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
  const scopeID = scopeExtensionID(options)
  const solidVersion = resolveSolidVersion(path.dirname(entry))

  /** @type {import("vite").Plugin} */
  const hostModules = {
    name: "opencode:extension-host-modules",
    enforce: "pre",
    config() {
      return {
        css: {
          // Inline PostCSS config: rewrites every selector in the extension
          // bundle to only match inside the host's `<div data-extension="...">`
          // mount (see scope.js). Keyframes, font-face and custom properties
          // are preserved.
          postcss: { plugins: [extensionScopePostcssPlugin(scopeID)] },
        },
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
              // Build metadata read by the host during activation (see
              // app/src/extensions/activation.ts): module.__opencodeBuild.solid
              // is compared against the host's shared solid-js version.
              // Minification may rewrite the local binding but the exported
              // name is preserved verbatim.
              banner: (chunk) =>
                chunk.isEntry && solidVersion
                  ? `export const __opencodeBuild = { solid: ${JSON.stringify(solidVersion)} };`
                  : "",
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
    buildStart() {
      if (!solidVersion) {
        this.warn("could not resolve solid-js for this extension; __opencodeBuild metadata will be omitted")
      }
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue
        const bare =
          /(?:\bfrom\s*["'](?:solid-js(?:\/[^"']*)?|@opencode-ai\/ui\/[^"']+)["']|\bimport\s*["'](?:solid-js(?:\/[^"']*)?|@opencode-ai\/ui\/[^"']+)["']|\bimport\s*\(\s*["'](?:solid-js(?:\/[^"']*)?|@opencode-ai\/ui\/[^"']+)["']\s*\))/.exec(
            output.code,
          )
        if (!bare) continue
        throw new Error(`OpenCode extension output contains an unresolved host import: ${bare[0]}`)
      }
    },
  }

  return [hostModules, solid()]
}
