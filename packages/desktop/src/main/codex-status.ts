import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import type { CliAgentConfig, CliAgentDetail, CliAgentInfo, CliAgentTest } from "../preload/types"
import { resolveDesktopPath } from "./native-path"

const execFileAsync = promisify(execFile)
const CODEX_SOURCE_URL = "https://github.com/openai/codex"

export function defaultCodexHome() {
  const env = process.env.CODEX_HOME?.trim()
  if (env) return resolveDesktopPath(env)
  return join(homedir(), ".codex")
}

export function resolveCodexHome(config?: CliAgentConfig) {
  const override = config?.configHome?.trim()
  if (override) return resolveDesktopPath(override)
  return defaultCodexHome()
}

/** Lightweight top-level / section TOML string reader (no full parser dependency). */
export function readTomlString(text: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))`, "m")
  const match = text.match(re)
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value?.trim() || undefined
}

export function readTomlSection(text: string, header: string): string {
  const marker = `[${header}]`
  const start = text.indexOf(marker)
  if (start < 0) return ""
  const bodyStart = start + marker.length
  const rest = text.slice(bodyStart)
  const next = rest.search(/\n\s*\[[^\]]+\]/)
  return next < 0 ? rest : rest.slice(0, next)
}

export function countTomlTables(text: string, prefix: string): number {
  // e.g. prefix "projects." matches [projects."/path"] and [projects.foo]
  const re = new RegExp(`^\\s*\\[${escapeRegExp(prefix)}`, "gm")
  return text.match(re)?.length ?? 0
}

export function parseCodexConfigToml(text: string): CliAgentDetail[] {
  const modelProvider = readTomlString(text, "model_provider")
  const providerSection =
    (modelProvider && readTomlSection(text, `model_providers.${modelProvider}`)) ||
    readTomlSection(text, "model_providers.custom")

  return details({
    Model: readTomlString(text, "model"),
    "Model provider": modelProvider,
    "Reasoning effort": readTomlString(text, "model_reasoning_effort"),
    "Context window": readTomlString(text, "model_context_window"),
    "Auto-compact limit": readTomlString(text, "model_auto_compact_token_limit"),
    "Sandbox mode": readTomlString(text, "sandbox_mode") ?? readTomlString(text, "sandbox"),
    "Approval policy": readTomlString(text, "approval_policy"),
    "Provider name": readTomlString(providerSection, "name") ?? modelProvider,
    "Provider base URL": readTomlString(providerSection, "base_url"),
    "Wire API": readTomlString(providerSection, "wire_api"),
    "Trusted projects": countTomlTables(text, "projects.").toString(),
  })
}

export async function resolveCodexBinary(config?: CliAgentConfig): Promise<string | undefined> {
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

  const candidates = process.platform === "win32" ? ["codex.exe", "codex"] : ["codex"]
  for (const name of candidates) {
    const found = await whichCommand(name)
    if (found) return found
  }
  return undefined
}

export async function getCodexInfo(config?: CliAgentConfig): Promise<CliAgentInfo> {
  const checkedAt = Date.now()
  const configHome = resolveCodexHome(config)
  const configPath = join(configHome, "config.toml")
  const info: CliAgentInfo = {
    sourceUrl: CODEX_SOURCE_URL,
    installed: false,
    configHome,
    configPath,
    checkedAt,
  }

  try {
    const binaryPath = await resolveCodexBinary(config)
    info.binaryPath = binaryPath
    if (binaryPath) {
      const version = await commandVersion(binaryPath)
      info.version = version
      info.installed = !!version || (await exists(binaryPath))
    }

    const configExists = await exists(configPath)
    info.configExists = configExists
    if (configExists) {
      const text = await readFile(configPath, "utf8")
      info.details = parseCodexConfigToml(text)
    }
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error)
  }

  return info
}

export async function testCodexConfig(config: CliAgentConfig): Promise<CliAgentTest> {
  const logs: string[] = []
  try {
    const info = await getCodexInfo(config)
    logs.push(`Config home: ${info.configHome ?? "-"}`)
    logs.push(`Config path: ${info.configPath ?? "-"} (${info.configExists ? "found" : "missing"})`)
    logs.push(`Binary: ${info.binaryPath ?? "not found"}`)
    logs.push(`Version: ${info.version ?? "unknown"}`)
    logs.push(`Installed: ${info.installed ? "yes" : "no"}`)
    logs.push(...(info.details ?? []).map((detail) => `${detail.label}: ${detail.value}`))
    if (info.error) logs.push(`Probe error: ${info.error}`)

    if (!info.installed) {
      logs.push("Codex CLI is not installed or not on PATH.")
      logs.push("Install with: npm install -g @openai/codex")
      return { ok: false, logs }
    }

    if (!info.version) {
      logs.push("Codex binary was found but `--version` returned no output.")
      return { ok: false, logs }
    }

    logs.push("Codex CLI probe succeeded.")
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function details(values: Record<string, string | undefined>): CliAgentDetail[] {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([label, value]) => ({ label, value: value! }))
}
