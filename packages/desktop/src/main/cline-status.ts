import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import type { CliAgentConfig, CliAgentDetail, CliAgentInfo, CliAgentTest } from "../preload/types"
import { resolveDesktopPath } from "./native-path"

const execFileAsync = promisify(execFile)
const CLINE_SOURCE_URL = "https://github.com/cline/cline"

export function defaultClineHome() {
  const env = process.env.CLINE_DIR?.trim()
  return env ? resolveDesktopPath(env) : join(homedir(), ".cline")
}

export function resolveClineHome(config?: CliAgentConfig) {
  const override = config?.configHome?.trim()
  return override ? resolveDesktopPath(override) : defaultClineHome()
}

export async function resolveClineBinary(config?: CliAgentConfig): Promise<string | undefined> {
  const override = config?.binaryPath?.trim()
  if (override) {
    if (isAbsolute(override) || override.includes("/") || override.includes("\\")) return resolveDesktopPath(override)
    return (await whichCommand(override)) ?? override
  }
  return whichCommand(process.platform === "win32" ? "cline.exe" : "cline")
}

export async function getClineInfo(config?: CliAgentConfig): Promise<CliAgentInfo> {
  const configHome = resolveClineHome(config)
  const configPath = join(configHome, "data", "settings", "global-settings.json")
  const info: CliAgentInfo = {
    sourceUrl: CLINE_SOURCE_URL,
    installed: false,
    configHome,
    configPath,
    checkedAt: Date.now(),
  }
  try {
    const binaryPath = await resolveClineBinary(config)
    info.binaryPath = binaryPath
    if (binaryPath) {
      info.version = await commandVersion(binaryPath, configHome)
      info.installed = !!info.version || (await exists(binaryPath))
    }
    info.configExists = await exists(configPath)
    if (info.configExists) info.details = parseClineSettings(await readFile(configPath, "utf8"))
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error)
  }
  return info
}

export function parseClineSettings(text: string): CliAgentDetail[] {
  try {
    const settings = JSON.parse(text)
    const model = settings?.model ?? settings?.defaultModel ?? settings?.apiProvider
    return typeof model === "string" && model ? [{ label: "Model", value: model }] : []
  } catch {
    return []
  }
}

export async function testClineConfig(config: CliAgentConfig): Promise<CliAgentTest> {
  const info = await getClineInfo(config)
  const logs = [
    `Config home: ${info.configHome ?? "-"}`,
    `Config path: ${info.configPath ?? "-"} (${info.configExists ? "found" : "missing"})`,
    `Binary: ${info.binaryPath ?? "not found"}`,
    `Version: ${info.version ?? "unknown"}`,
    `Installed: ${info.installed ? "yes" : "no"}`,
    ...(info.details ?? []).map((detail) => `${detail.label}: ${detail.value}`),
  ]
  if (info.error) logs.push(`Probe error: ${info.error}`)
  if (!info.installed) return { ok: false, logs: [...logs, "Cline CLI is not installed or not on PATH."] }
  if (!info.version) return { ok: false, logs: [...logs, "Cline binary was found but `--version` returned no output."] }
  return { ok: true, logs: [...logs, "Cline CLI probe succeeded."] }
}

async function commandVersion(command: string, home: string) {
  const result = await execFileAsync(command, ["--version"], {
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, CLINE_DIR: home },
  }).catch(() => undefined)
  const text = result?.stdout?.trim() || result?.stderr?.trim()
  return text?.split(/\r?\n/)[0]
}

async function whichCommand(command: string) {
  const checker = process.platform === "win32" ? "where" : "which"
  const result = await execFileAsync(checker, [command], { timeout: 3000, windowsHide: true, env: process.env }).catch(
    () => undefined,
  )
  return result?.stdout?.trim().split(/\r?\n/)[0] || undefined
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
