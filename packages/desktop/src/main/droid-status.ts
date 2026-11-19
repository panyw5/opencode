import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import type { CliAgentConfig, CliAgentDetail, CliAgentInfo, CliAgentTest } from "../preload/types"
import { resolveDesktopPath } from "./native-path"

const execFileAsync = promisify(execFile)
const DROID_SOURCE_URL = "https://docs.factory.ai"

export function defaultDroidHome() {
  const env = process.env.DROID_CONFIG_DIR?.trim()
  if (env) return resolveDesktopPath(env)
  const override = process.env.FACTORY_HOME_OVERRIDE?.trim()
  return override ? join(resolveDesktopPath(override), ".factory") : join(homedir(), ".factory")
}

export function resolveDroidHome(config?: CliAgentConfig) {
  const override = config?.configHome?.trim()
  return override ? resolveDesktopPath(override) : defaultDroidHome()
}

export async function resolveDroidBinary(config?: CliAgentConfig): Promise<string | undefined> {
  const override = config?.binaryPath?.trim()
  if (override) {
    if (isAbsolute(override) || override.includes("/") || override.includes("\\")) return resolveDesktopPath(override)
    return (await whichCommand(override)) ?? override
  }
  return whichCommand(process.platform === "win32" ? "droid.exe" : "droid")
}

export async function getDroidInfo(config?: CliAgentConfig): Promise<CliAgentInfo> {
  const configHome = resolveDroidHome(config)
  const configPath = join(configHome, "settings.json")
  const info: CliAgentInfo = {
    sourceUrl: DROID_SOURCE_URL,
    installed: false,
    configHome,
    configPath,
    checkedAt: Date.now(),
  }
  try {
    const binaryPath = await resolveDroidBinary(config)
    info.binaryPath = binaryPath
    if (binaryPath) {
      info.version = await commandVersion(binaryPath, configHome)
      info.installed = !!info.version || (await exists(binaryPath))
    }
    info.configExists = await exists(configPath)
    if (info.configExists) info.details = parseDroidSettings(await readFile(configPath, "utf8"))
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error)
  }
  return info
}

export function parseDroidSettings(text: string): CliAgentDetail[] {
  try {
    const settings = JSON.parse(text)
    const model = settings?.model ?? settings?.defaultModel
    return typeof model === "string" && model ? [{ label: "Model", value: model }] : []
  } catch {
    return []
  }
}

export async function testDroidConfig(config: CliAgentConfig): Promise<CliAgentTest> {
  const info = await getDroidInfo(config)
  const logs = [
    `Config home: ${info.configHome ?? "-"}`,
    `Config path: ${info.configPath ?? "-"} (${info.configExists ? "found" : "missing"})`,
    `Binary: ${info.binaryPath ?? "not found"}`,
    `Version: ${info.version ?? "unknown"}`,
    `Installed: ${info.installed ? "yes" : "no"}`,
    ...(info.details ?? []).map((detail) => `${detail.label}: ${detail.value}`),
  ]
  if (info.error) logs.push(`Probe error: ${info.error}`)
  if (!info.installed) return { ok: false, logs: [...logs, "Factory Droid CLI is not installed or not on PATH."] }
  if (!info.version) return { ok: false, logs: [...logs, "Droid binary was found but `--version` returned no output."] }
  return { ok: true, logs: [...logs, "Factory Droid CLI probe succeeded."] }
}

async function commandVersion(command: string, home: string) {
  const result = await execFileAsync(command, ["--version"], {
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, FACTORY_HOME_OVERRIDE: dirname(home) },
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
