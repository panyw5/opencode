import path from "node:path"
import { accessSync, constants } from "node:fs"

export type ChildRuntimeInput = {
  execPath: string
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  find?: (name: string) => string | undefined
}

function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const suffixes = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix.toLowerCase()}`)
      try {
        accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK)
        return candidate
      } catch {
        // Keep searching PATH; this is an optional demo dependency.
      }
    }
  }
}

/** A compiled opencode executable cannot execute `-e` as a JS runtime. */
export function resolveChildRuntime(input: ChildRuntimeInput) {
  const platform = input.platform ?? process.platform
  const executable = path.basename(input.execPath).toLowerCase().replace(/\.exe$/, "")
  if (executable === "bun" || executable === "node") return input.execPath

  const override = input.env.OPENCODE_JS_RUNTIME?.trim()
  if (override) return override
  const find = input.find ?? ((name: string) => findOnPath(name, input.env, platform))
  const runtime = find("bun") ?? find("node")
  if (runtime) return runtime
  throw new Error("hello-viewer child needs bun or node on PATH; set OPENCODE_JS_RUNTIME to a JS runtime executable")
}
