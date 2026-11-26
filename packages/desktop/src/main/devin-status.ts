import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import type { CliAgentConfig, CliAgentDetail, CliAgentInfo, CliAgentTest } from "../preload/types"
import { resolveDesktopPath } from "./native-path"

const execFileAsync = promisify(execFile)
const DEVIN_SOURCE_URL = "https://devin.ai/docs/cli"

export function defaultDevinHome() {
  const env = process.env.DEVIN_CONFIG_DIR?.trim()
  return env ? resolveDesktopPath(env) : join(homedir(), ".config", "devin")
}

export function resolveDevinHome(config?: CliAgentConfig) {
  const override = config?.configHome?.trim()
  return override ? resolveDesktopPath(override) : defaultDevinHome()
}

export async function resolveDevinBinary(config?: CliAgentConfig): Promise<string | undefined> {
  const override = config?.binaryPath?.trim()
  if (override) {
    if (isAbsolute(override) || override.includes("/") || override.includes("\\")) return resolveDesktopPath(override)
    return (await whichCommand(override)) ?? override
  }
  return (
    (await whichCommand(process.platform === "win32" ? "devin.exe" : "devin")) ??
    (await whichCommand(process.platform === "win32" ? "devin.cmd" : "devin"))
  )
}

export async function getDevinInfo(config?: CliAgentConfig): Promise<CliAgentInfo> {
  const configHome = resolveDevinHome(config)
  const configPath = join(configHome, "config.json")
  const info: CliAgentInfo = {
    sourceUrl: DEVIN_SOURCE_URL,
    installed: false,
    configHome,
    configPath,
    checkedAt: Date.now(),
  }
  try {
    const binaryPath = await resolveDevinBinary(config)
    info.binaryPath = binaryPath
    if (binaryPath) {
      info.version = await commandVersion(binaryPath, configHome)
      info.installed = !!info.version || (await exists(binaryPath))
    }
    info.configExists = await exists(configPath)
    if (info.configExists) info.details = parseDevinSettings(await readFile(configPath, "utf8"))
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error)
  }
  return info
}

export function parseDevinSettings(text: string): CliAgentDetail[] {
  try {
    const settings = JSON.parse(text)
    const model = settings?.agent?.model
    const org = settings?.devin?.org_id
    const details: CliAgentDetail[] = []
    if (typeof org === "string" && org) details.push({ label: "Org", value: org })
    if (typeof model === "string" && model) details.push({ label: "Model", value: model })
    return details
  } catch {
    return []
  }
}

export async function testDevinConfig(config: CliAgentConfig): Promise<CliAgentTest> {
  const info = await getDevinInfo(config)
  const logs = [
    `Config home: ${info.configHome ?? "-"}`,
    `Config path: ${info.configPath ?? "-"} (${info.configExists ? "found" : "missing"})`,
    `Binary: ${info.binaryPath ?? "not found"}`,
    `Version: ${info.version ?? "unknown"}`,
    `Installed: ${info.installed ? "yes" : "no"}`,
    ...(info.details ?? []).map((detail) => `${detail.label}: ${detail.value}`),
  ]
  if (info.error) logs.push(`Probe error: ${info.error}`)
  if (!info.installed) return { ok: false, logs: [...logs, "Devin CLI is not installed or not on PATH."] }
  if (!info.version) return { ok: false, logs: [...logs, "Devin binary was found but `version` returned no output."] }
  return { ok: true, logs: [...logs, "Devin CLI probe succeeded."] }
}

async function commandVersion(command: string, home: string) {
  const result = await execFileAsync(command, ["--version"], {
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, DEVIN_CONFIG_DIR: home },
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
