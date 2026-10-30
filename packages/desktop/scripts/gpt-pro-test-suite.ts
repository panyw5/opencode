import { access } from "node:fs/promises"
import { join, resolve } from "node:path"

export const gptProTestModes = [
  "unit",
  "list",
  "baseline",
  "native",
  "logged-out",
  "live",
  "live-rich",
  "live-multipage",
  "help",
] as const
export type GptProTestMode = (typeof gptProTestModes)[number]

export function gptProTestMode(args: string[]): GptProTestMode {
  if (!args.length) return "unit"
  if (args.length !== 1 || !args[0].startsWith("--")) throw Error("Choose exactly one GPT-Pro test mode; use --help")
  const mode = args[0].slice(2)
  if (!(gptProTestModes as readonly string[]).includes(mode)) throw Error("Unknown GPT-Pro test mode; use --help")
  return mode as GptProTestMode
}

type Layer = { name: string; package?: string; roots: string[]; extra: string[]; preload: string[]; filter?: string }
const layers: Layer[] = [
  { name: "util", roots: ["src"], extra: [], preload: [] },
  {
    name: "desktop",
    roots: ["src/main", "scripts"],
    extra: ["src/main/browser-cdp.test.ts", "src/main/browser-presentation.test.ts"],
    preload: [],
  },
  {
    name: "app",
    roots: ["src"],
    extra: [
      "src/browser/tabs.test.ts",
      "src/components/prompt-input/consult-mentions.test.ts",
      "src/components/prompt-input/slash-popover.test.ts",
    ],
    preload: ["--preload", "./happydom.ts"],
  },
  { name: "ui", roots: ["src"], extra: ["src/components/injected-prompt-model.test.ts"], preload: [] },
  {
    name: "opencode",
    roots: ["test"],
    extra: ["test/browser/browser.test.ts", "test/browser/bridge.test.ts", "test/tool/browser-tools.test.ts"],
    preload: [],
  },
  {
    name: "opencode-routing",
    package: "opencode",
    roots: [],
    extra: ["test/session/prompt.test.ts", "test/tool/consult-mention.test.ts"],
    preload: [],
    filter: "GPT-Pro|@gpt-pro|^Pro (progress|completion)",
  },
]

export async function gptProTestSuites(root: string) {
  return Promise.all(
    layers.map(async (layer) => {
      const directory = resolve(root, "packages", layer.package ?? layer.name)
      const files = new Set(layer.extra)
      for (const source of layer.roots) {
        for await (const file of new Bun.Glob("**/*.test.ts").scan({ cwd: join(directory, source), onlyFiles: true })) {
          if (/(?:^|\/)[^/]*gpt[-_]pro[^/]*\.test\.ts$/.test(file)) files.add(`${source}/${file}`)
        }
      }
      for (const file of files) await access(join(directory, file))
      if (!files.size) throw Error(`No GPT-Pro tests found in ${layer.name}`)
      return {
        name: layer.name,
        package: layer.package ?? layer.name,
        directory,
        files: [...files].sort(),
        preload: layer.preload,
        filter: layer.filter,
      }
    }),
  )
}
