import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import type { CliAgentConfig, CliAgentDetail, CliAgentInfo, CliAgentTest } from "../preload/types"
import { resolveDesktopPath } from "./native-path"

const execFileAsync = promisify(execFile)
const CLAUDE_SOURCE_URL = "https://docs.anthropic.com/en/docs/claude-code"

export function defaultClaudeHome() {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim()
  if (env) return resolveDesktopPath(env)
  return join(homedir(), ".claude")
}

export function resolveClaudeHome(config?: CliAgentConfig) {
  const override = config?.configHome?.trim()
  if (override) return resolveDesktopPath(override)
  return defaultClaudeHome()
}

export async function resolveClaudeBinary(config?: CliAgentConfig): Promise<string | undefined> {
  const override = config?.binaryPath?.trim()
  if (override) {
    if (isAbsolute(override) || override.includes("/") || override.includes("\\")) {
      const path = resolveDesktopPath(override)
      if (await exists(path)) return path
      return path
    }
    const fromPath = await whichCommand(override)
    if (fromPath) return fromPath
    return override
  }

  const candidates = process.platform === "win32" ? ["claude.exe", "claude"] : ["claude"]
  for (const name of candidates) {
    const found = await whichCommand(name)
    if (found) return found
  }
  return undefined
}

export async function getClaudeInfo(config?: CliAgentConfig): Promise<CliAgentInfo> {
  const checkedAt = Date.now()
  const configHome = resolveClaudeHome(config)
  const settingsPath = join(configHome, "settings.json")
  const info: CliAgentInfo = {
    sourceUrl: CLAUDE_SOURCE_URL,
    installed: false,
    configHome,
    configPath: settingsPath,
    checkedAt,
  }

  try {
    const binaryPath = await resolveClaudeBinary(config)
    info.binaryPath = binaryPath
    if (binaryPath) {
      const version = await commandVersion(binaryPath)
      info.version = version
      info.installed = !!version || (await exists(binaryPath))
    }

    info.configExists = await exists(settingsPath)
    if (info.configExists) info.details = parseClaudeSettingsJson(await readFile(settingsPath, "utf8"))
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error)
  }

  return info
}

export function parseClaudeSettingsJson(text: string): CliAgentDetail[] {
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    return details({
      Model: readString(json, "model"),
      "Permission mode": readString(json, "permissionMode"),
      "Default mode": readString(json, "defaultMode"),
      "API key helper": readString(json, "apiKeyHelper"),
    })
  } catch {
    return []
  }
}

export async function testClaudeConfig(config: CliAgentConfig): Promise<CliAgentTest> {
  const logs: string[] = []
  try {
    const info = await getClaudeInfo(config)
    logs.push(`Config home: ${info.configHome ?? "-"}`)
    logs.push(`Settings path: ${info.configPath ?? "-"} (${info.configExists ? "found" : "missing"})`)
    logs.push(`Binary: ${info.binaryPath ?? "not found"}`)
    logs.push(`Version: ${info.version ?? "unknown"}`)
    logs.push(`Installed: ${info.installed ? "yes" : "no"}`)
    logs.push(...(info.details ?? []).map((detail) => `${detail.label}: ${detail.value}`))
    if (info.error) logs.push(`Probe error: ${info.error}`)

    if (!info.installed) {
      logs.push("Claude CLI is not installed or not on PATH.")
      logs.push("Install Claude Code and ensure `claude` is available on PATH.")
      return { ok: false, logs }
    }

    if (!info.version) {
      logs.push("Claude binary was found but `--version` returned no output.")
      return { ok: false, logs }
    }

    logs.push("Claude CLI probe succeeded.")
    return { ok: true, logs }
  } catch (error) {
    logs.push(error instanceof Error ? error.message : String(error))
    return { ok: false, logs }
  }
}

async function commandVersion(command: string) {
  const result = await execFileAsync(command, ["--version"], {
    timeout: 5000,
    windowsHide: true,
    env: process.env,
  }).catch(() => undefined)
  const text = result?.stdout?.trim() || result?.stderr?.trim()
  if (!text) return undefined
  return text.split(/\r?\n/)[0]
}

async function whichCommand(command: string) {
  const checker = process.platform === "win32" ? "where" : "which"
  const result = await execFileAsync(checker, [command], {
    timeout: 3000,
    windowsHide: true,
    env: process.env,
  }).catch(() => undefined)
  const line = result?.stdout?.trim().split(/\r?\n/)[0]
  return line || undefined
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function details(values: Record<string, string | undefined>): CliAgentDetail[] {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([label, value]) => ({ label, value: value! }))
}
