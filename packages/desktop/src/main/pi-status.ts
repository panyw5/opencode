import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import type { CliAgentConfig, CliAgentInfo, CliAgentTest } from "../preload/types"
import { resolveDesktopPath } from "./native-path"

const execute = promisify(execFile)
const sourceUrl = "https://github.com/earendil-works/pi"

export function parsePiSettings(text: string) {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const settings = value as Record<string, unknown>
  return ["defaultProvider", "defaultModel", "defaultThinkingLevel"].flatMap((key) =>
    typeof settings[key] === "string" ? [{ label: key, value: settings[key] }] : [],
  )
}

export async function getPiInfo(config?: CliAgentConfig): Promise<CliAgentInfo> {
  const configHome = resolveDesktopPath(
    config?.configHome?.trim() || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  )
  const configPath = join(configHome, "settings.json")
  const info: CliAgentInfo = { sourceUrl, installed: false, configHome, configPath, checkedAt: Date.now() }
  try {
    const requested = config?.binaryPath?.trim() || process.env.OPENCODE_PI_BIN?.trim() || "pi"
    const binary =
      isAbsolute(requested) || requested.includes("/") || requested.includes("\\")
        ? resolveDesktopPath(requested)
        : (
            await execute(process.platform === "win32" ? "where" : "which", [requested], {
              timeout: 3000,
              windowsHide: true,
            }).catch(() => undefined)
          )?.stdout
            .trim()
            .split(/\r?\n/)[0]
    info.binaryPath = binary
    if (binary) {
      const script = /\.[cm]?js$/.test(binary)
      const version = await execute(script ? "node" : binary, [...(script ? [binary] : []), "--version"], {
        env: { ...process.env, PI_CODING_AGENT_DIR: configHome, PI_OFFLINE: "1" },
        timeout: 10000,
        windowsHide: true,
      })
      info.version = version.stdout.trim().split(/\r?\n/)[0]
      info.installed = !!info.version
    }
    info.configExists = await access(configPath).then(
      () => true,
      () => false,
    )
    if (info.configExists) info.details = parsePiSettings(await readFile(configPath, "utf8"))
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error)
  }
  return info
}

export async function testPiConfig(config: CliAgentConfig): Promise<CliAgentTest> {
  const info = await getPiInfo(config)
  return {
    ok: info.installed && !info.error,
    logs: [
      `Pi binary: ${info.binaryPath ?? "not found"}`,
      `Version: ${info.version ?? "unknown"}`,
      `PI_CODING_AGENT_DIR: ${info.configHome}`,
      `Settings: ${info.configExists ? "found" : "missing (defaults will be used)"}`,
      ...(info.details ?? []).map((detail) => `${detail.label}: ${detail.value}`),
      ...(info.error ? [`Probe failed: ${info.error}`] : []),
      info.installed
        ? "Pi executable probe passed. RPC/message tests run separately."
        : "Pi is not runnable. Install Pi or select a built CLI entry point.",
    ],
  }
}
