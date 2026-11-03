import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const solid = createRequire(require.resolve("vite-plugin-solid"))
const vite = createRequire(require.resolve("vite"))
const { transformSync } = solid("@babel/core")
const preset = solid("babel-preset-solid")
const esbuild = vite("esbuild")

// Used only by the isolated form contract process, never the shared test suite.
Bun.plugin({
  name: "solid-form-contract",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, (args) => {
      const stripped = esbuild.transformSync(readFileSync(args.path, "utf8"), {
        loader: "tsx",
        jsx: "preserve",
        target: "esnext",
      })
      const result = transformSync(stripped.code, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        presets: [preset],
      })
      return { contents: result.code, loader: "js" }
    })
  },
})
