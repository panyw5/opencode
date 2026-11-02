import path from "node:path"
import { homedir } from "node:os"
import { existsSync } from "node:fs"
import { which } from "@/util/which"

export type ExternalCliID = "codex" | "claude" | "dsh" | "grok"
export type ExternalCliConfig = { enabled?: boolean; binaryPath?: string; configHome?: string }

const homes = {
  codex: ["CODEX_HOME", ".codex"],
  claude: ["CLAUDE_CONFIG_DIR", ".claude"],
  dsh: ["DSH_HOME", ".dsh"],
  grok: ["GROK_HOME", ".grok"],
} as const

export function resolveExternalCli(
  id: ExternalCliID,
  config?: ExternalCliConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  const stored = (() => {
    if (!env.OPENCODE_EXTERNAL_AGENTS) return undefined
    try {
      const value = JSON.parse(env.OPENCODE_EXTERNAL_AGENTS)[id]
      if (!value || typeof value !== "object") return undefined
      return {
        enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
        binaryPath: typeof value.binaryPath === "string" ? value.binaryPath : undefined,
        configHome: typeof value.configHome === "string" ? value.configHome : undefined,
      }
    } catch {
      throw new Error("Invalid desktop external agent configuration")
    }
  })()
  const effective = { ...stored, ...config }
  if (effective.enabled === false) throw new Error(id + " integration is disabled")
  const base = env.OPENCODE_CLIENT === "desktop" ? homedir() : process.cwd()
  const expand = (value: string) =>
    value === "~" ? homedir() : /^~[/\\]/.test(value) ? path.join(homedir(), value.slice(2)) : value
  const executable = expand(effective.binaryPath?.trim() || id)
  const managed = path.join(
    path.resolve(base, expand(env.GROK_HOME?.trim() || path.join(homedir(), ".grok"))),
    "bin",
    process.platform === "win32" ? "grok.exe" : "grok",
  )
  const binary = /[/\\]/.test(executable)
    ? path.resolve(base, executable)
    : (which(executable, env) ??
      (id === "grok" && !effective.binaryPath?.trim() && existsSync(managed) ? managed : undefined))
  if (!binary)
    throw new Error(id + " CLI not found. Install it or configure its executable in Settings > External agents.")
  const [variable, folder] = homes[id]
  const home = path.resolve(
    base,
    expand(effective.configHome?.trim() || env[variable]?.trim() || path.join(homedir(), folder)),
  )
  return { binary, home, env: { [variable]: home } }
}

export function externalTurnFailure(input: {
  advisor: string
  exitCode: number | null
  completed?: boolean
  error?: string
  answer: string
  stderr: string
}): string | undefined {
  if (input.exitCode !== 0 || input.error || !input.completed) {
    const reason =
      input.error || input.stderr.trim().slice(0, 2000) || "Stream ended without a successful terminal event"
    return input.advisor + " failed (exit " + input.exitCode + "): " + reason
  }
  if (!input.answer.trim()) return input.advisor + " returned an empty response"
  return undefined
}
