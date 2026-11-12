#!/usr/bin/env bun
// Out-of-repo build verification for @opencode-ai/extension-kit (T4.2).
//
// Packs the kit into a tarball, scaffolds a web-and-server extension project
// in a temporary directory (modelled on templates/extensions/ plus the web
// half of packages/extensions/hello-viewer), installs the tarball from file:,
// then runs the same steps an external extension author would:
//
//   vite build            (web entry → dist/web, host-module shims, CSS scoping)
//   bun build server.ts   (server entry → dist/server.js)
//   tsc --noEmit          (typecheck against the shipped dist/*.d.ts)
//
// Usage: bun script/verify-pack.ts [--keep]
//   --keep  preserve the temporary project directory for inspection
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"

const keep = process.argv.includes("--keep")
const repo = path.resolve(import.meta.dir, "..")
const kitDir = path.join(repo, "packages", "extension-kit")
const EXTENSION_ID = "example.verify-pack"

function fail(message: string): never {
  throw new Error(`verify-pack: ${message}`)
}

async function packKit(outdir: string): Promise<string> {
  const out = await $`${process.execPath} ./script/pack.ts --outdir ${outdir}`.cwd(kitDir).text()
  const line = out.trim().split("\n").at(-1) ?? ""
  const match = /^packed: (.+\.tgz)$/.exec(line)
  if (!match) fail(`pack script did not report a tarball path: ${out}`)
  if (!existsSync(match[1])) fail(`reported tarball does not exist: ${match[1]}`)
  return match[1]
}

async function scaffold(dir: string, tarball: string) {
  const pkg = {
    name: "opencode-extension-verify-pack",
    version: "0.0.0",
    private: true,
    type: "module",
    opencode: {
      manifestVersion: 1,
      id: EXTENSION_ID,
      displayName: "Verify Pack",
      description: "Out-of-repo build fixture for @opencode-ai/extension-kit.",
      web: { apiVersion: 1, styles: ["./dist/web/index.css"] },
      activation: ["onStartup"],
      contributes: { panels: [{ id: "verify-pack", title: "Verify Pack" }] },
      permissions: [],
    },
    devDependencies: {
      "@opencode-ai/extension-kit": `file:${tarball}`,
      "@opencode-ai/plugin": "^1.19.0",
      "@types/node": "^22.0.0",
      "solid-js": "~1.9.0",
      typescript: "^5.9.0",
      vite: "^7.0.0",
      "vite-plugin-solid": "^2.11.0",
    },
  }
  await mkdir(path.join(dir, "src"), { recursive: true })
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2))

  await writeFile(
    path.join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          jsx: "preserve",
          jsxImportSource: "solid-js",
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["esnext", "dom", "dom.iterable"],
          strict: true,
          isolatedModules: true,
          noEmit: true,
        },
        include: ["src", "vite.config.ts"],
      },
      null,
      2,
    ),
  )

  await writeFile(
    path.join(dir, "vite.config.ts"),
    `import { defineConfig } from "vite"
import extensionKit from "@opencode-ai/extension-kit/vite"

export default defineConfig({
  plugins: extensionKit(),
})
`,
  )

  await writeFile(
    path.join(dir, "src", "contract.ts"),
    `export type Contract = {
  echo: { input: { text: string }; output: { echo: string } }
}
`,
  )

  await writeFile(
    path.join(dir, "src", "server.ts"),
    `import { defineServerExtension } from "@opencode-ai/extension-kit/server"
import { defineRpc } from "@opencode-ai/extension-kit/rpc"
import type { Contract } from "./contract"

const rpc = defineRpc<Contract>()

export default defineServerExtension({
  id: "${EXTENSION_ID}",
  async activate() {
    return {
      rpc: rpc.handlers({
        echo: async (input) => ({ echo: input.text }),
      }),
    }
  },
})
`,
  )

  await writeFile(
    path.join(dir, "src", "web.tsx"),
    `import { createSignal } from "solid-js"
import { defineWebExtension } from "@opencode-ai/extension-kit/web"
import { defineRpc } from "@opencode-ai/extension-kit/rpc"
import type { Contract } from "./contract"
import "./web.css"

const rpc = defineRpc<Contract>()

export default defineWebExtension({
  id: "${EXTENSION_ID}",
  apiVersion: 1,
  activate(context) {
    const call = rpc.bind(context.rpc)
    void call("echo", { text: "ping" })
    const [count] = createSignal(0)
    context.panels.register({
      id: "verify-pack",
      component: () => <div class="verify-pack">{count()}</div>,
    })
  },
})
`,
  )

  await writeFile(path.join(dir, "src", "web.css"), `.verify-pack { color: #336699; }\n`)
}

async function assert(condition: unknown, message: string) {
  if (!condition) fail(message)
}

const workdir = await mkdtemp(path.join(tmpdir(), "opencode-kit-verify-"))
console.log(`workdir: ${workdir}`)

try {
  console.log("== pack kit ==")
  const tarball = await packKit(workdir)
  console.log(`tarball: ${tarball}`)

  // The packed exports must point at dist while keeping the development→src
  // condition; check the tarball's package.json before installing it.
  const unpackedPkg = JSON.parse(
    (await $`tar -xOf ${tarball} package/package.json`.text()),
  ) as { exports: Record<string, Record<string, string>> }
  for (const subpath of ["./web", "./rpc", "./server"] as const) {
    const conditions = unpackedPkg.exports[subpath]
    if (!conditions) fail(`packed exports is missing ${subpath}`)
    if (!conditions.types?.startsWith("./dist/")) fail(`packed ${subpath} types does not point at dist: ${JSON.stringify(conditions)}`)
    if (!conditions.import?.startsWith("./dist/")) fail(`packed ${subpath} import does not point at dist: ${JSON.stringify(conditions)}`)
    if (conditions.development !== `./src/${subpath.slice(2)}.ts`)
      fail(`packed ${subpath} development does not point at src: ${JSON.stringify(conditions)}`)
  }
  console.log("packed exports: types/import -> dist, development -> src")

  console.log("== scaffold extension project ==")
  const project = path.join(workdir, "extension")
  await scaffold(project, tarball)

  console.log("== npm install ==")
  await $`npm install --no-audit --no-fund --loglevel=error`.cwd(project)

  console.log("== vite build (web) ==")
  await $`${process.execPath} ./node_modules/vite/bin/vite.js build`.cwd(project)
  const webJs = path.join(project, "dist", "web", "index.js")
  const webCss = path.join(project, "dist", "web", "index.css")
  await assert(existsSync(webJs), "vite build did not emit dist/web/index.js")
  await assert(existsSync(webCss), "vite build did not emit dist/web/index.css")
  const js = await readFile(webJs, "utf8")
  const css = await readFile(webCss, "utf8")
  await assert(js.includes("__OPENCODE_EXTENSION_HOST__"), "web bundle is missing the host-module shim")
  await assert(!/\bfrom\s*["']solid-js["']/.test(js), "web bundle kept a bare solid-js import")
  await assert(css.includes(`[data-extension="${EXTENSION_ID}"]`), "web css was not scoped to the extension id")
  console.log("web bundle: host shim applied, css scoped")

  console.log("== bun build (server) ==")
  await $`${process.execPath} build src/server.ts --outfile dist/server.js --target=node --format=esm`.cwd(project).env({
    ...process.env,
    NODE_ENV: "production",
  })
  const serverJs = path.join(project, "dist", "server.js")
  await assert(existsSync(serverJs), "bun build did not emit dist/server.js")
  const server = await readFile(serverJs, "utf8")
  await assert(server.includes("invalid_input"), "server bundle is missing kit/rpc runtime code")
  console.log("server bundle: kit server+rpc code bundled")

  console.log("== tsc --noEmit (typecheck) ==")
  await $`${process.execPath} ./node_modules/typescript/bin/tsc --noEmit`.cwd(project)
  console.log("typecheck passed")

  console.log("\nverify-pack: PASS")
  console.log(`workdir: ${workdir}`)
} finally {
  if (!keep) await rm(workdir, { recursive: true, force: true })
}
