import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  Switch,
  untrack,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon, type IconName, type IconProps } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Select } from "@opencode-ai/ui/select"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { Switch as Toggle } from "@opencode-ai/ui/switch"
import { showPromiseToast, showToast } from "@opencode-ai/ui/toast"
import { applyEdits, modify, parse } from "jsonc-parser"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { paint } from "@/components/prompt-input/expand"
import { pair } from "@/components/dialog-prompt-editor-input"
import { handleTextareaIndent, indent } from "@/components/markdown-editor-indent"
import { DialogConnectProvider } from "@/components/dialog-connect-provider"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import {
  OPENAI_COMPATIBLE,
  headerRow as blankHeaderRow,
  modelConfig as modelConfigRows,
  modelConfigPlaceholder,
  modelRow as blankModelRow,
  type FormState,
  type HeaderRow,
  type ModelConfigRow,
  type ModelRow,
  validateCustomProvider,
} from "@/components/dialog-custom-provider-form"
import { FetchProviderModels } from "@/components/fetch-provider-models"
import { JsonCodeField } from "@/components/json-code-field"
import { TestProviderModelButton } from "@/components/test-provider-model-button"
import { Link } from "@/components/link"
import { paintCode } from "@/utils/paint-code"
import { useLanguage } from "@/context/language"
import { useLayout, type LocalProject } from "@/context/layout"
import { ModelSelectorPopover, useBoundModelState } from "@/components/dialog-select-model"
import {
  type ConfigTreeItem,
  type CliAgentConfig,
  type CliAgentDescriptor,
  type CliAgentID,
  type CliAgentInfo,
  type ConfigWorkspace,
  type DshPluginEntry,
  type DshPluginInventory,
  type ExtraAgentInfo,
  type GenericagentConfig,
  type HermesConfig,
  type OpenclawConfig,
  usePlatform,
} from "@/context/platform"
import { monoFontFamily, useSettings } from "@/context/settings"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
import { normalizeProviderList, stripProvider } from "@/context/global-sync/utils"
import {
  canSignOutProvider,
  collectConfigProviders,
  isBuiltinProvider,
  nextDisabledProviders,
  providerEnabled,
  type ConfigProviderItem,
} from "./config-provider-list"
import {
  CONFIG_MIDDLE_ITEM_ACTIVE_CLASS,
  CONFIG_MIDDLE_ITEM_CLASS,
  CONFIG_MIDDLE_ITEM_INACTIVE_CLASS,
} from "./config-provider-list-shared"
import { fetchSkillMarketFile, loadSkillMarketIndex } from "./config-skill-market"
import { SectionButton } from "./config-section-button"
import { ServerConnection, useServer } from "@/context/server"
import { extraAgentById, extraAgents, mainDomain } from "@/pages/layout/extra-agents"
import {
  basename,
  classifyPluginSource,
  classifySkillSource,
  isFilePath,
  localPath,
  normalizePath,
} from "@/utils/config-source"
import { configPluginKey, pluginKey, relativePluginSpecifier, updatePluginEntries } from "@/utils/config-plugin"
import { CONFIG_PAGE_REFRESH_EVENT, refreshAfterConfigWrite } from "@/utils/config-reload"
import type { Agent, Config, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { configAgentDisplayItems, configuredAgentsFromJsonc, jsoncAgentVariantOptions } from "./config-agent-display"
import {
  changedProviderEntry,
  declaredMcpEntries,
  declaredMcpEntry,
  declaredProviderEntry,
  globalProviderPatch,
  formatArgv,
  mcpDeclarationRecords,
  mcpSelectionID,
  parseArgv,
  parseMcpSelectionID,
  selectProjectMcpConfig,
  updateProjectMcpText,
} from "./config-persistence"
import {
  CHANNEL_PLATFORMS,
  channelPick,
  ConfigChannelsDetail,
  parseChannelPick,
  useChannelMiddleItems,
} from "./config-channels"

const CORE_SECTIONS = [
  "providers",
  "agents-md",
  "agents",
  "skills",
  "plugins",
  "mcp",
  "commands",
  "channels",
  "claws",
] as const
type CoreSection = (typeof CORE_SECTIONS)[number]
type Section = CoreSection | (string & {})

function isKnownSection(value: string): boolean {
  if ((CORE_SECTIONS as readonly string[]).includes(value)) return true
  return extraAgents.some((agent) => agent.configSection === value)
}

type SkillGroup = "opencode" | "claude" | "project" | "external" | "plugin" | "global" | "builtin" | "config"

type JsoncAgentForm = {
  model: string
  variant: string
  temperature: string
  topP: string
  description: string
  prompt: string
  mode: "" | "subagent" | "primary" | "all"
  hidden: boolean
  disable: boolean
  color: string
  steps: string
  permission: string
  options: string
}

type DocItem = {
  id: string
  label: string
  path: string
  editable: boolean
  source: string
  note?: string
  content?: string
  warn?: string
  group?: SkillGroup
  project?: string
  origin?: string
  root?: string
}

type SkillItem = {
  name: string
  description?: string
  location: string
  content: string
  editable: boolean
  source: string
  warn?: string
  group: SkillGroup
  project?: string
  origin?: string
  root?: string
}

type ProviderItem = ConfigProviderItem

type ProviderCfg = NonNullable<Config["provider"]>[string]

type CustomState = FormState & {
  mode: "create" | "edit"
  saving: boolean
  deleting: boolean
  secret: boolean
}

const CUSTOM_NEW = "provider:_new_custom"
const SKILL_NEW = "skill:_new_custom"
const COMMAND_NEW = "cmd:_new_custom"
const MCP_NEW = "mcp:_new"

const CUSTOM_PROVIDER_NPM_PACKAGES: readonly string[] = [OPENAI_COMPATIBLE, "@ai-sdk/openai", "@ai-sdk/anthropic"]

function customProviderNpmPackages(value: string | undefined): string[] {
  const current = value?.trim()
  if (current && !CUSTOM_PROVIDER_NPM_PACKAGES.includes(current)) return [current, ...CUSTOM_PROVIDER_NPM_PACKAGES]
  return [...CUSTOM_PROVIDER_NPM_PACKAGES]
}

type SkillMarketRepo = {
  id: string
  label: string
  repo: string
  description: string
  url: string
  branch?: string
  path?: string
}

type SkillMarketItem = {
  id: string
  name: string
  description: string
  path: string
  repo: string
  repoLabel: string
  content: string
  sourceUrl: string
  folder: string
}

type SkillMarketInstallScope = "global" | "project"

type SkillMarketProjectTarget = {
  label: string
  root: string
  installed: Set<string>
}

type SkillMarketLoadResult = {
  skills: SkillMarketItem[]
  error?: string
}

type SkillMarketLoadStage = "index" | "skills"

type SkillMarketLoadMeta = {
  repo: string
  slow: boolean
  timeoutMs: number
  stage: SkillMarketLoadStage
  total: number
  completed: number
  failed: number
}

type ParsedSkillMarketRepo = {
  repo: string
  branch?: string
}

const CUSTOM_SKILL_MARKET_PREFIX = "custom-skill-market:"
const CUSTOM_SKILL_MARKET_STORAGE_KEY = "opencode.config.skillMarket.customRepos"
const CUSTOM_SKILL_MARKET_STORAGE_LIMIT = 24
const SKILL_MARKET_LOAD_TIMEOUT_MS = 30_000
const SKILL_MARKET_SLOW_LOAD_MS = 8_000
const SKILL_MARKET_FILE_TIMEOUT_MS = 12_000
const SKILL_MARKET_FILE_CONCURRENCY = 8

const SKILL_MARKET_REPOS: SkillMarketRepo[] = [
  {
    id: "anthropics-skills",
    label: "Anthropic Skills",
    repo: "anthropics/skills",
    description: "Official Claude Skills examples and reusable workflows.",
    url: "https://github.com/anthropics/skills",
  },
  {
    id: "openai-skills",
    label: "OpenAI Skills",
    repo: "openai/skills",
    description: "OpenAI skill packages and examples for Codex-style workflows.",
    url: "https://github.com/openai/skills",
  },
  {
    id: "mattpocock-skills",
    label: "Matt Pocock Skills",
    repo: "mattpocock/skills",
    description: "TypeScript-focused skills and development workflows.",
    url: "https://github.com/mattpocock/skills",
  },
  {
    id: "composio-skills",
    label: "Composio Awesome Claude Skills",
    repo: "ComposioHQ/awesome-claude-skills",
    description: "Community-curated Claude skills for common automation tasks.",
    url: "https://github.com/ComposioHQ/awesome-claude-skills",
  },
  {
    id: "opencode-power-pack",
    label: "OpenCode Power Pack",
    repo: "waybarrios/opencode-power-pack",
    description: "Community OpenCode skills, agents, and workflow packages.",
    url: "https://github.com/waybarrios/opencode-power-pack",
  },
  {
    id: "academicforge-claude-science",
    label: "AcademicForge Claude Science",
    repo: "HughYau/AcademicForge",
    branch: "site-first",
    path: "skills/claude-science",
    description: "Science and research skills from the AcademicForge Claude Science collection.",
    url: "https://github.com/HughYau/AcademicForge/tree/site-first/skills/claude-science",
  },
]

type PluginItem = {
  id: string
  label: string
  name: string
  enabled: boolean
  exists: boolean
  path?: string
  spec?: string
  group: "global" | "project" | "external"
  project?: string
  root?: string
  origin?: string
}

type PluginSource = Pick<PluginItem, "group" | "project" | "root" | "origin">

type ClawItem = {
  id: string
  label: string
  note?: string
  meta?: string
  sourceUrl: string
  enabled: boolean
}

type TreeNode = {
  path: string
  kind: "file" | "directory"
  kids: TreeNode[]
}

function name(path: string) {
  return basename(path)
}

function dir(path: string) {
  const list = path.split(/[\\/]/)
  if (list.length < 2) return path
  return list.slice(0, -1).join("/")
}

function short(path: string, root?: string) {
  if (!root) return path
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "")
  const next = path.replace(/\\/g, "/")
  if (next === base) return name(next)
  if (!next.startsWith(base + "/")) return path
  return next.slice(base.length + 1)
}

function local(path: string) {
  return localPath(path)
}

function plugin(path: string) {
  const next = local(path)
  const stem = name(next).replace(/\.(?:ts|js|mjs|cjs|mts|cts)$/i, "")
  if (path.startsWith("file://")) return stem
  if (next !== path) return stem
  if (path.includes("/") || path.includes("\\")) return stem
  const last = path.lastIndexOf("@")
  if (last > 0) return path.slice(0, last)
  return path
}

function spec(path: string) {
  return new URL(path.startsWith("file://") ? path : `file://${path}`).href
}

function norm(path: string) {
  return normalizePath(path)
}

function join(root: string, ...parts: string[]) {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/"
  return [root.replace(/[\\/]+$/, ""), ...parts.map((item) => item.replace(/^[\\/]+|[\\/]+$/g, ""))]
    .filter(Boolean)
    .join(sep)
}

function file(path: string) {
  return isFilePath(path)
}

function projectRoots(item: { worktree: string; sandboxes?: string[] }) {
  return Array.from(new Set([item.worktree, ...(item.sandboxes ?? [])].filter((root) => file(root))))
}

function rel(root: string, path: string) {
  const base = norm(root)
  const next = norm(path)
  if (next === base) return name(next)
  if (!next.startsWith(base + "/")) return name(next)
  return next.slice(base.length + 1)
}

function stem(path: string) {
  return path.replace(/\.(?:md|mdx|d\.ts|ts|js|mjs|cjs)$/i, "")
}

function pkg(spec: string | [string, Record<string, unknown>]) {
  if (Array.isArray(spec)) spec = spec[0]
  if (spec.startsWith("file://")) return
  if (spec.includes("\\") || spec.startsWith("/") || /^[A-Za-z]:\//.test(spec)) return
  const last = spec.lastIndexOf("@")
  if (last > 0) {
    return { name: spec.slice(0, last), version: spec.slice(last + 1) || "latest" }
  }
  return { name: spec, version: "latest" }
}

function cleanFrontmatterValue(value: string) {
  return value.trim().replace(/\s+/g, " ")
}

function frontmatterData(text: string) {
  const hit = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!hit) return

  const lines = hit[1].split(/\r?\n/)
  const data: Record<string, string> = {}

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!line) continue

    const key = line[1]
    const raw = line[2].trim()
    const block = raw.match(/^([|>])[-+]?$/)

    if (block) {
      const blockLines: string[] = []
      for (let next = index + 1; next < lines.length; next++) {
        const blockLine = lines[next]
        if (/^[A-Za-z0-9_-]+:\s*/.test(blockLine) || (blockLine.trim() && !/^\s/.test(blockLine))) {
          index = next - 1
          break
        }

        blockLines.push(blockLine)
        index = next
      }

      const indents = blockLines
        .filter((blockLine) => blockLine.trim())
        .map((blockLine) => blockLine.match(/^\s*/)?.[0].length ?? 0)
      const indent = indents.length ? Math.min(...indents) : 0
      data[key] = cleanFrontmatterValue(
        blockLines
          .map((blockLine) => blockLine.slice(Math.min(indent, blockLine.length)))
          .join(block[1] === ">" ? " " : "\n"),
      )
      continue
    }

    data[key] = cleanFrontmatterValue(raw.replace(/^['"]|['"]$/g, ""))
  }

  return data
}

function markdownBody(text: string) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim()
}

function skillMeta(text: string, path: string) {
  const data = frontmatterData(text)
  if (!data) {
    return {
      name: name(dir(path)),
      description: "Skill metadata is incomplete.",
      warn: "Missing frontmatter. Add `name` and `description` to `SKILL.md`.",
    }
  }

  const miss = [!data.name && "`name`", !data.description && "`description`"].filter((item): item is string => !!item)

  return {
    name: data.name || name(dir(path)),
    description: data.description || "Skill metadata is incomplete.",
    warn: miss.length ? `Incomplete metadata. Add ${miss.join(" and ")} to the frontmatter.` : undefined,
  }
}

function skillFolder(value: string, fallback: string) {
  const next = (value.trim() || fallback.trim() || "skill")
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!next || next === "." || next === "..") return "skill"
  return next
}

function cleanRepoParts(repo: string, branch?: string): ParsedSkillMarketRepo | undefined {
  const parts = repo
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
  if (parts.length !== 2) return

  const owner = parts[0]
  const repoName = parts[1].replace(/\.git$/i, "")
  const normalized = `${owner}/${repoName}`
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) return

  const nextBranch = branch?.trim().replace(/^\/+|\/+$/g, "")
  return { repo: normalized, branch: nextBranch || undefined }
}

function decodePathPart(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseSkillMarketRepoInput(value: string): ParsedSkillMarketRepo | undefined {
  const input = value.trim()
  if (!input) return

  let raw = input
  let branch: string | undefined
  const hash = raw.indexOf("#")
  if (hash >= 0) {
    branch = raw.slice(hash + 1).trim()
    raw = raw.slice(0, hash).trim()
  }

  raw = raw.replace(/^git@github\.com:/i, "https://github.com/")
  if (/^github\.com\//i.test(raw)) raw = `https://${raw}`

  if (/^https?:\/\//i.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return
    }

    const host = url.hostname.toLowerCase().replace(/^www\./, "")
    if (host !== "github.com") return

    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length < 2) return
    if (!branch && parts[2] === "tree" && parts[3]) {
      branch = parts.slice(3).map(decodePathPart).join("/")
    }
    return cleanRepoParts(`${parts[0]}/${parts[1]}`, branch)
  }

  return cleanRepoParts(raw, branch)
}

function skillMarketRepoID(repo: ParsedSkillMarketRepo) {
  return `${CUSTOM_SKILL_MARKET_PREFIX}${repo.repo}${repo.branch ? `#${repo.branch}` : ""}`
}

function skillMarketRepoURL(repo: ParsedSkillMarketRepo) {
  if (!repo.branch) return `https://github.com/${repo.repo}`
  const branch = repo.branch.split("/").map(encodeURIComponent).join("/")
  return `https://github.com/${repo.repo}/tree/${branch}`
}

function isCustomSkillMarketRepoID(id: string) {
  return id.startsWith(CUSTOM_SKILL_MARKET_PREFIX)
}

function storedSkillMarketRepo(value: unknown): ParsedSkillMarketRepo | undefined {
  if (typeof value === "string") return parseSkillMarketRepoInput(value)
  if (typeof value !== "object" || value === null) return

  const record = value as Record<string, unknown>
  if (typeof record.repo !== "string") return
  const branch = typeof record.branch === "string" ? record.branch : undefined
  return cleanRepoParts(record.repo, branch)
}

function uniqueSkillMarketRepos(repos: ParsedSkillMarketRepo[]) {
  const next = new Map<string, ParsedSkillMarketRepo>()
  for (const repo of repos) {
    next.set(skillMarketRepoID(repo), repo)
  }
  return Array.from(next.values()).slice(0, CUSTOM_SKILL_MARKET_STORAGE_LIMIT)
}

function loadStoredSkillMarketRepos(): ParsedSkillMarketRepo[] {
  if (typeof localStorage !== "object") return []

  try {
    const raw = localStorage.getItem(CUSTOM_SKILL_MARKET_STORAGE_KEY)
    if (!raw) return []

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return uniqueSkillMarketRepos(
      parsed.map(storedSkillMarketRepo).filter((item): item is ParsedSkillMarketRepo => !!item),
    )
  } catch {
    return []
  }
}

function saveStoredSkillMarketRepos(repos: ParsedSkillMarketRepo[]) {
  if (typeof localStorage !== "object") return

  try {
    localStorage.setItem(CUSTOM_SKILL_MARKET_STORAGE_KEY, JSON.stringify(uniqueSkillMarketRepos(repos)))
  } catch {
    // Best-effort UI preference persistence.
  }
}

function prependSkillMarketRepo(repos: ParsedSkillMarketRepo[], repo: ParsedSkillMarketRepo) {
  return uniqueSkillMarketRepos([repo, ...repos.filter((item) => skillMarketRepoID(item) !== skillMarketRepoID(repo))])
}

function sameSkillMarketRepos(a: ParsedSkillMarketRepo[], b: ParsedSkillMarketRepo[]) {
  if (a.length !== b.length) return false
  return a.every((repo, index) => {
    const other = b[index]
    return !!other && skillMarketRepoID(repo) === skillMarketRepoID(other)
  })
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

function isSkillMarketTimeoutError(error: unknown) {
  return error instanceof Error && error.name === "SkillMarketTimeoutError"
}

function skillMarketTimeoutError(message: string) {
  const error = new Error(message)
  error.name = "SkillMarketTimeoutError"
  return error
}

async function withSkillMarketTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout()
          reject(skillMarketTimeoutError(`Skill marketplace request timed out after ${timeoutMs / 1000}s`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function loadMarketSkills(
  repo: SkillMarketRepo,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  onProgress?: (progress: Omit<SkillMarketLoadMeta, "repo" | "slow" | "timeoutMs">) => void,
): Promise<SkillMarketItem[]> {
  onProgress?.({ stage: "index", total: 0, completed: 0, failed: 0 })
  const { branch, paths, source } = await withSkillMarketTimeout(
    loadSkillMarketIndex(repo, fetcher, signal),
    SKILL_MARKET_LOAD_TIMEOUT_MS,
    () => {
      console.warn(`[skill-market] index timeout repo=${repo.repo} branch=${repo.branch ?? ""}`)
    },
  )
  console.log(
    `[skill-market] load skills repo=${repo.repo} branch=${branch} source=${source} count=${String(paths.length)}`,
  )
  onProgress?.({ stage: "skills", total: paths.length, completed: 0, failed: 0 })

  let loaded = 0
  let failed = 0
  let cursor = 0
  const list: Array<SkillMarketItem | undefined> = []
  const workerCount = Math.min(SKILL_MARKET_FILE_CONCURRENCY, paths.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < paths.length) {
      const index = cursor
      cursor += 1
      const path = paths[index]
      if (!path) continue
      try {
        console.log(`[skill-market] fetch skill repo=${repo.repo} branch=${branch} path=${path}`)
        list[index] = await withSkillMarketTimeout(
          (async () => {
            const file = await fetchSkillMarketFile(fetcher, repo.repo, branch, path, signal)
            const meta = skillMeta(file.content, path)
            const folder = skillFolder(meta.name, name(dir(path)))
            return {
              id: `${repo.repo}:${path}`,
              name: meta.name,
              description: meta.description,
              path,
              repo: repo.repo,
              repoLabel: repo.label,
              content: file.content,
              sourceUrl: file.url,
              folder,
            }
          })(),
          SKILL_MARKET_FILE_TIMEOUT_MS,
          () => {
            console.warn(`[skill-market] skill timeout repo=${repo.repo} branch=${branch} path=${path}`)
          },
        )
        if (list[index]) loaded += 1
        else failed += 1
      } catch (err) {
        failed += 1
        console.warn(`[skill-market] skill failed repo=${repo.repo} branch=${branch} path=${path} error=${String(err)}`)
      } finally {
        onProgress?.({ stage: "skills", total: paths.length, completed: loaded + failed, failed })
      }
    }
  })

  await Promise.all(workers)

  const skills = list
    .filter((item): item is SkillMarketItem => !!item)
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))

  if (paths.length && skills.length === 0) {
    throw new Error(`Failed to read ${paths.length} SKILL.md files`)
  }

  return skills
}

function script(path?: string) {
  const ext = name(local(path ?? ""))
    .split(".")
    .at(-1)
    ?.toLowerCase()
  if (["js", "mjs", "cjs", "ts", "mts", "cts", "tsx", "jsx"].includes(ext ?? "")) return true
  return false
}

function sourceKey(source?: string) {
  if (source === "opencode") return "config.badge.opencode"
  if (source === "project") return "config.badge.project"
  if (source === "external") return "config.badge.external"
  if (source === "env") return "config.badge.env"
  if (source === "api") return "config.badge.api"
  if (source === "config") return "config.badge.config"
  if (source === "custom") return "config.badge.custom"
  return undefined
}



function home(path: string) {
  const list = norm(path).split("/").filter(Boolean)
  if (list.at(-1) !== "opencode") return
  if (list.at(-2) !== ".config") return
  const root = path.startsWith("/") ? "/" : ""
  return root + list.slice(0, -2).join("/")
}

function sortTree(list: ConfigTreeItem[]) {
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "file" ? -1 : 1
    return name(a.path).localeCompare(name(b.path))
  })
}

function ext(path: string) {
  const base = name(path)
  const dot = base.lastIndexOf(".")
  if (dot < 0) return ""
  return base.slice(dot + 1).toLowerCase()
}

function treeGlyph(path: string, kind: TreeNode["kind"]) {
  if (kind === "directory") return { tone: "folder", label: "" }
  const base = name(path).toLowerCase()
  const type = ext(path)
  if (base === "package.json") return { tone: "node", label: "N" }
  if (base.endsWith("lock.json") || base === "bun.lock" || base === "bun.lockb" || base === "pnpm-lock.yaml") {
    return { tone: "lock", label: "L" }
  }
  if (base === ".gitignore" || base === ".gitattributes" || base === ".gitmodules") return { tone: "git", label: "G" }
  if (type === "py") return { tone: "python", label: "PY" }
  if (["ts", "tsx"].includes(type)) return { tone: "ts", label: "TS" }
  if (["js", "jsx", "mjs", "cjs"].includes(type)) return { tone: "js", label: "JS" }
  if (["json", "jsonc"].includes(type)) return { tone: "json", label: "{}" }
  if (["yaml", "yml", "toml", "ini"].includes(type)) return { tone: "cfg", label: "CF" }
  if (["md", "mdx"].includes(type) || base === "readme" || base === "readme.md") return { tone: "md", label: "MD" }
  if (["sh", "bash", "zsh", "fish", "ps1"].includes(type)) return { tone: "sh", label: "SH" }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(type)) return { tone: "img", label: "IM" }
  if (["zip", "gz", "tgz", "tar", "rar", "7z"].includes(type)) return { tone: "zip", label: "AR" }
  if (["rs", "go", "java", "swift", "kt", "rb", "php", "c", "cc", "cpp", "h", "hpp"].includes(type)) {
    return { tone: "code", label: "<>" }
  }
  if (base.startsWith(".")) return { tone: "dot", label: ".*" }
  return { tone: "file", label: "FI" }
}

function TreeGlyph(props: { path: string; kind: TreeNode["kind"] }) {
  const glyph = createMemo(() => treeGlyph(props.path, props.kind))
  const tone = createMemo(() => {
    const value = glyph().tone
    if (value === "folder") return "text-[#9fb1bf]"
    if (value === "python") return "text-[#4ea1f3]"
    if (value === "ts") return "text-[#4ea1f3]"
    if (value === "js") return "text-[#f0c04a]"
    if (value === "json") return "text-[#d16d9e]"
    if (value === "cfg") return "text-[#77c3b4]"
    if (value === "md") return "text-[#5aa2ff]"
    if (value === "sh") return "text-[#7dcf85]"
    if (value === "img") return "text-[#d79a5c]"
    if (value === "zip") return "text-[#c9a66b]"
    if (value === "git") return "text-[#e47d61]"
    if (value === "lock") return "text-[#d5b46a]"
    if (value === "node") return "text-[#78b35f]"
    if (value === "dot") return "text-[#9d92c7]"
    if (value === "code") return "text-[#7aa2f7]"
    return "text-[#aeb6c2]"
  })

  return (
    <div class={`relative mt-0.5 flex size-4 shrink-0 items-center justify-center ${tone()}`}>
      <Show
        when={props.kind === "directory"}
        fallback={
          <>
            <svg viewBox="0 0 16 16" class="size-4" fill="none" aria-hidden="true">
              <path d="M3 1.75H9.25L12.25 4.75V14.25H3V1.75Z" fill="currentColor" fill-opacity="0.12" />
              <path d="M3 1.75H9.25L12.25 4.75V14.25H3V1.75Z" stroke="currentColor" stroke-width="1" />
              <path d="M9.25 1.75V4.75H12.25" stroke="currentColor" stroke-width="1" />
            </svg>
            <div class="pointer-events-none absolute inset-0 flex items-end justify-center pb-[1px] text-[7px] font-semibold leading-none tracking-[-0.02em] text-current">
              {glyph().label}
            </div>
          </>
        }
      >
        <svg viewBox="0 0 16 16" class="size-4" fill="none" aria-hidden="true">
          <path d="M1.75 4.25H6L7.25 2.75H14.25V13.25H1.75V4.25Z" fill="currentColor" fill-opacity="0.12" />
          <path d="M1.75 4.25H6L7.25 2.75H14.25V13.25H1.75V4.25Z" stroke="currentColor" stroke-width="1" />
        </svg>
      </Show>
    </div>
  )
}

function patchText(input: string, path: (string | number)[], value: unknown) {
  return applyEdits(
    input,
    modify(input, path, value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    }),
  )
}

function jsoncAgentForm(input: NonNullable<Config["agent"]>[string] | undefined): JsoncAgentForm {
  const prettyJson = (value: unknown) => (value && typeof value === "object" ? JSON.stringify(value, null, 2) : "")
  return {
    model: typeof input?.model === "string" ? input.model : "",
    variant: typeof input?.variant === "string" ? input.variant : "",
    temperature: typeof input?.temperature === "number" ? String(input.temperature) : "",
    topP: typeof input?.top_p === "number" ? String(input.top_p) : "",
    description: typeof input?.description === "string" ? input.description : "",
    prompt: typeof input?.prompt === "string" ? input.prompt : "",
    mode: input?.mode === "subagent" || input?.mode === "primary" || input?.mode === "all" ? input.mode : "",
    hidden: input?.hidden === true,
    disable: input?.disable === true,
    color: typeof input?.color === "string" ? input.color : "",
    steps: typeof input?.steps === "number" ? String(input.steps) : "",
    permission: prettyJson(input?.permission),
    options: prettyJson(input?.options),
  }
}

function jsoncObjectField(label: string, value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${label} must be valid JSON.`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`)
  return parsed as Record<string, unknown>
}

function JsoncAgentEditor(props: {
  name: string
  config?: NonNullable<Config["agent"]>[string]
  onSave: (form: JsoncAgentForm) => Promise<void>
}) {
  const language = useLanguage()
  const [form, setForm] = createStore(jsoncAgentForm(props.config))
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")

  const formModel = useBoundModelState({
    value: () => form.model,
    onChange: (next) => setForm("model", next),
  })
  const selectedModel = createMemo(() => formModel.current())
  const variantOptions = createMemo(() => jsoncAgentVariantOptions(selectedModel()?.variants, form.variant))

  createEffect(
    on(
      () => [props.name, props.config] as const,
      ([, config]) => {
        setForm(jsoncAgentForm(config))
        setError("")
      },
      { defer: false },
    ),
  )

  async function save() {
    setSaving(true)
    setError("")
    try {
      await props.onSave(form)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border-weak-base px-5 py-4">
        <div>
          <div class="flex items-center gap-2">
            <div class="text-20-medium text-text-strong">{props.name}</div>
            <span class="rounded-full bg-surface-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-weak">
              opencode.jsonc
            </span>
          </div>
          <div class="mt-1 text-12-regular text-text-weak">{language.t("config.agents.jsonc.description")}</div>
        </div>
        <SaveButton
          label={saving() ? language.t("config.agents.jsonc.saving") : language.t("common.save")}
          onClick={() => void save()}
          disabled={saving()}
        />
      </div>
      <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
        <div class="mx-auto flex max-w-[920px] flex-col gap-6">
          <Show when={error()}>
            {(message) => <div class="text-12-regular text-text-danger-base">{message()}</div>}
          </Show>
          <div class="grid gap-4 md:grid-cols-2">
            <div class="flex flex-col gap-2">
              <label class="text-12-medium text-text-weak">{language.t("config.agents.field.model")}</label>
              <div class="flex min-w-0 items-center gap-1">
                <ModelSelectorPopover
                  model={formModel}
                  triggerAs={Button}
                  triggerProps={{
                    type: "button",
                    variant: "ghost",
                    class:
                      "h-10 min-w-0 flex-1 justify-between rounded-lg border border-border-weak-base bg-background-base px-3 text-13-regular text-text-strong hover:border-border-strong hover:bg-surface-base-hover",
                  }}
                >
                  <div class="flex min-w-0 items-center gap-2">
                    <Show when={selectedModel()?.provider?.id}>
                      <ProviderIcon id={selectedModel()!.provider.id} class="size-4 shrink-0" />
                    </Show>
                    <span class="truncate">
                      {selectedModel()
                        ? `${selectedModel()!.provider.name} / ${selectedModel()!.name}`
                        : form.model.trim() || language.t("config.agents.field.default")}
                    </span>
                  </div>
                  <Icon name="chevron-down" size="small" class="shrink-0 text-text-weak" />
                </ModelSelectorPopover>
                <Show when={form.model.trim()}>
                  <IconButton
                    icon="close"
                    variant="ghost"
                    iconSize="small"
                    class="size-10 shrink-0"
                    aria-label={language.t("config.agents.field.default")}
                    onClick={() => formModel.set(undefined)}
                  />
                </Show>
              </div>
            </div>
            <div class="flex flex-col gap-2">
              <label class="text-12-medium text-text-weak">{language.t("config.agents.field.variant")}</label>
              <Select
                options={variantOptions()}
                current={variantOptions().find((value) => value === form.variant)}
                onSelect={(value) => {
                  console.info("[config] jsonc agent variant selected", { name: props.name, variant: value ?? "" })
                  setForm("variant", value ?? "")
                }}
                variant="secondary"
                size="large"
                triggerStyle={{ width: "100%", "justify-content": "space-between", transform: "none" }}
              >
                {(value) => <span>{value || language.t("config.agents.field.default")}</span>}
              </Select>
            </div>
            <TextField
              label={language.t("config.agents.field.temperature")}
              inputmode="decimal"
              value={form.temperature}
              onChange={(value) => setForm("temperature", value)}
            />
            <TextField
              label={language.t("config.agents.field.topP")}
              inputmode="decimal"
              value={form.topP}
              onChange={(value) => setForm("topP", value)}
            />
            <TextField
              label={language.t("config.agents.field.color")}
              placeholder="primary or #FF5733"
              value={form.color}
              onChange={(value) => setForm("color", value)}
            />
            <TextField
              label={language.t("config.agents.field.steps")}
              inputmode="numeric"
              value={form.steps}
              onChange={(value) => setForm("steps", value)}
            />
            <TextField
              label={language.t("config.agents.field.description")}
              value={form.description}
              onChange={(value) => setForm("description", value)}
            />
            <div class="flex flex-col gap-2">
              <label class="text-12-medium text-text-weak">{language.t("config.agents.field.mode")}</label>
              <Select
                options={["", "primary", "subagent", "all"] as const}
                current={(["", "primary", "subagent", "all"] as const).find((value) => value === form.mode)}
                onSelect={(value) => setForm("mode", value ?? "")}
                variant="secondary"
                size="large"
                triggerStyle={{ width: "100%", "justify-content": "space-between", transform: "none" }}
              >
                {(value) => <span>{value || language.t("config.agents.field.default")}</span>}
              </Select>
            </div>
          </div>
          <div class="grid gap-4 md:grid-cols-2">
            <Toggle checked={form.hidden} onChange={(value) => setForm("hidden", value)}>
              {language.t("config.agents.field.hidden")}
            </Toggle>
            <Toggle checked={form.disable} onChange={(value) => setForm("disable", value)}>
              {language.t("config.agents.field.disabled")}
            </Toggle>
          </div>
          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-weak">{language.t("config.agents.field.prompt")}</label>
            <textarea
              class="min-h-40 rounded-xl border border-border-weak-base bg-background-base p-3 text-13-regular text-text-base outline-none"
              value={form.prompt}
              onInput={(event) => setForm("prompt", event.currentTarget.value)}
              onKeyDown={(event) => handleTextareaIndent(event, form.prompt, (next) => setForm("prompt", next.text))}
            />
          </div>
          <div class="grid gap-4 lg:grid-cols-2">
            <div class="flex flex-col gap-2">
              <label class="text-12-medium text-text-weak">{language.t("config.agents.field.permission")}</label>
              <textarea
                class="min-h-36 rounded-xl border border-border-weak-base bg-background-base p-3 font-mono text-12-regular text-text-base outline-none"
                value={form.permission}
                onInput={(event) => setForm("permission", event.currentTarget.value)}
                onKeyDown={(event) =>
                  handleTextareaIndent(event, form.permission, (next) => setForm("permission", next.text))
                }
              />
            </div>
            <div class="flex flex-col gap-2">
              <label class="text-12-medium text-text-weak">{language.t("config.agents.field.options")}</label>
              <textarea
                class="min-h-36 rounded-xl border border-border-weak-base bg-background-base p-3 font-mono text-12-regular text-text-base outline-none"
                value={form.options}
                onInput={(event) => setForm("options", event.currentTarget.value)}
                onKeyDown={(event) =>
                  handleTextareaIndent(event, form.options, (next) => setForm("options", next.text))
                }
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

async function loadConfigFileAgents(
  platform: Pick<ReturnType<typeof usePlatform>, "listConfigFiles" | "readLocalFile">,
) {
  if (!platform.listConfigFiles || !platform.readLocalFile) return
  const files = await platform.listConfigFiles(null)
  const file = files.find(
    (item) => item.scope === "global" && item.kind === "config" && item.label === "opencode.jsonc",
  )
  if (!file?.exists) return
  return configuredAgentsFromJsonc((await platform.readLocalFile(file.path)) ?? "")
}

function providerCfg(input: ProviderCfg | undefined): CustomState {
  const headers = input?.options?.headers
  const models = Object.entries(input?.models ?? {})
  const env = Array.isArray(input?.env) && input.env.length > 0 ? `{env:${input.env[0]}}` : ""
  const api = typeof input?.options?.apiKey === "string" ? input.options.apiKey : ""
  return {
    mode: input ? "edit" : "create",
    providerID: "",
    npm: input?.npm ?? OPENAI_COMPATIBLE,
    name: input?.name ?? "",
    baseURL: typeof input?.options?.baseURL === "string" ? input.options.baseURL : "",
    apiKey: api || env,
    models:
      models.length > 0
        ? models.map(([id, item]) => {
            const row = blankModelRow()
            return {
              ...row,
              id,
              name: typeof item?.name === "string" ? item.name : id,
              config: modelConfigRows(item as Record<string, unknown>),
              err: {},
            }
          })
        : [blankModelRow()],
    headers:
      headers && typeof headers === "object" && !Array.isArray(headers) && Object.keys(headers).length > 0
        ? Object.entries(headers)
            .filter((item): item is [string, string] => typeof item[1] === "string")
            .map(([key, value]) => ({
              row: blankHeaderRow().row,
              key,
              value,
              err: {},
            }))
        : [blankHeaderRow()],
    saving: false,
    deleting: false,
    secret: true,
    err: {},
  }
}

function clawCfg(input?: OpenclawConfig) {
  return {
    enabled: input?.enabled ?? false,
    url: input?.url ?? "",
    token: input?.token ?? "",
    saving: false,
    testing: false,
    detecting: false,
    err: {
      url: "",
    },
    test: undefined as undefined | { ok: boolean; logs: string[] },
    run: 0,
  }
}

function gaCfg(input?: GenericagentConfig) {
  return {
    enabled: input?.enabled ?? false,
    pythonExecutable: input?.pythonExecutable ?? "",
    genericAgentDir: input?.genericAgentDir ?? "",
    saving: false,
    testing: false,
    err: {
      genericAgentDir: "",
    },
    test: undefined as undefined | { ok: boolean; logs: string[] },
    run: 0,
  }
}

function hmCfg(input?: HermesConfig) {
  return {
    enabled: input?.enabled ?? false,
    pythonExecutable: input?.pythonExecutable ?? "",
    hermesDir: input?.hermesDir ?? "",
    hermesHome: input?.hermesHome ?? "",
    saving: false,
    testing: false,
    err: {
      hermesDir: "",
    },
    test: undefined as undefined | { ok: boolean; logs: string[] },
    run: 0,
  }
}

function cliAgentCfg(
  input?: CliAgentConfig & {
    provider?: string
    model?: string
    baseURL?: string
    apiKey?: string
    hasFileApiKey?: boolean
    apiKeyEnvSet?: boolean
    baseUrlEnvSet?: boolean
  },
) {
  return {
    enabled: input?.enabled ?? true,
    binaryPath: input?.binaryPath ?? "",
    configHome: input?.configHome ?? "",
    provider: input?.provider ?? "deepseek-official",
    model: input?.model ?? "deepseek-v4-flash",
    baseURL: input?.baseURL ?? "",
    apiKey: input?.apiKey ?? "",
    secret: true,
    clearApiKey: false,
    hasFileApiKey: input?.hasFileApiKey ?? false,
    apiKeyEnvSet: input?.apiKeyEnvSet ?? false,
    baseUrlEnvSet: input?.baseUrlEnvSet ?? false,
    saving: false,
    testing: false,
    err: {} as Record<string, string>,
    test: undefined as undefined | { ok: boolean; logs: string[] },
    run: 0,
  }
}

function fuzzy(text: string, query: string) {
  const a = text.toLowerCase()
  const b = query.trim().toLowerCase()
  if (!b) return true
  let i = 0
  for (const ch of a) {
    if (ch === b[i]) i += 1
    if (i === b.length) return true
  }
  return a.includes(b)
}

function skillSearchMatchField(value: string, term: string) {
  const text = value.toLowerCase()
  if (text.includes(term)) return true

  const words = text.split(/[^a-z0-9]+/).filter(Boolean)
  if (words.some((word) => word.startsWith(term))) return true

  const acronym = words.map((word) => word[0]).join("")
  return acronym.startsWith(term)
}

function skillSearchMatch(fields: Array<string | undefined>, query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true

  const values = fields.filter((field): field is string => !!field?.trim())
  return terms.every((term) => values.some((value) => skillSearchMatchField(value, term)))
}

function sectionIcon(section: Section): IconProps["name"] {
  if (section === "agents-md") return "review"
  if (section === "providers") return "providers"
  if (section === "agents") return "robot"
  if (section === "skills") return "book"
  if (section === "plugins") return "code"
  if (section === "mcp") return "mcp"
  if (section === "commands") return "terminal"
  if (section === "channels") return "speech-bubble"
  const agent = extraAgents.find((item) => item.configSection === section)
  if (agent) return agent.icon
  return "openclaw"
}

const CONFIG_PANE_FOCUS_CLASS =
  "relative z-[1] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--text-strong)_22%,transparent),inset_0_0_0_3px_color-mix(in_srgb,var(--text-strong)_8%,transparent)]"

const ProviderEnabledBlock = lazy(() => import("./config-provider-enabled-block"))
const ProviderDisabledBlock = lazy(() => import("./config-provider-disabled-block"))

function ListButton(props: {
  active: boolean
  title: string
  note?: string
  meta?: string
  warn?: boolean
  tone?: "danger"
  titleClass?: string
  onClick: () => void
  extra?: JSX.Element
}) {
  return (
    <button
      type="button"
      class="group flex w-full items-start justify-between gap-3 border-b border-border-weak-base px-3 py-3 text-left transition-[background-color,border-color,box-shadow] duration-150"
      classList={{
        "bg-transparent hover:bg-[color-mix(in_srgb,var(--surface-brand-base)_6%,var(--background-base))]": !props.active,
        "border-border-base bg-[color-mix(in_srgb,var(--surface-brand-base)_14%,var(--background-base))] shadow-[inset_3px_0_0_color-mix(in_srgb,var(--surface-brand-base)_55%,transparent)]":
          props.active,
      }}
      onClick={props.onClick}
    >
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <div
            class="truncate text-13-medium transition-colors"
            classList={{
              "text-text-danger-base": props.tone === "danger",
              [props.titleClass ?? "text-text-strong"]: props.tone !== "danger",
            }}
          >
            {props.title}
          </div>
          <Show when={props.warn}>
            <Icon name="help" size="small" class="shrink-0 text-warning-base" />
          </Show>
        </div>
        <Show when={props.note}>
          <div
            class="mt-1 line-clamp-2 text-12-regular transition-colors"
            classList={{
              "text-text-weak": !props.active,
              "text-text-base": props.active,
            }}
          >
            {props.note}
          </div>
        </Show>
        <Show when={props.meta}>
          <div
            class="mt-2 break-all font-mono text-[12px] leading-5 transition-colors"
            classList={{
              "text-text-weak": !props.active,
              "text-text-base": props.active,
            }}
          >
            {props.meta}
          </div>
        </Show>
      </div>
      <Show when={props.extra}>
        <div class="shrink-0">{props.extra}</div>
      </Show>
    </button>
  )
}

function SkillListButton(props: {
  active: boolean
  title: string
  note?: string
  icon?: IconName
  warn?: boolean
  warnLabel?: string
  deletable?: boolean
  onDelete?: () => void
  onClick: () => void
}) {
  const language = useLanguage()
  const [confirmDelete, setConfirmDelete] = createSignal(false)

  function handleDeleteClick(e: MouseEvent) {
    e.stopPropagation()
    if (confirmDelete()) {
      props.onDelete?.()
      setConfirmDelete(false)
    } else {
      setConfirmDelete(true)
    }
  }

  createEffect(() => {
    if (!confirmDelete()) return
    const handler = () => setConfirmDelete(false)
    document.addEventListener("click", handler)
    onCleanup(() => document.removeEventListener("click", handler))
  })

  return (
    <button
      type="button"
      class={CONFIG_MIDDLE_ITEM_CLASS}
      classList={{
        [CONFIG_MIDDLE_ITEM_ACTIVE_CLASS]: props.active,
        [CONFIG_MIDDLE_ITEM_INACTIVE_CLASS]: !props.active,
      }}
      onClick={props.onClick}
    >
      <div class="flex min-w-0 flex-1 items-start gap-3">
        <div
          class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150"
          classList={{
            "bg-surface-danger-base/15 text-text-danger-base": !!props.warn,
            "bg-surface-secondary text-text-strong": props.active && !props.warn,
            "bg-surface-secondary/70 text-text-base group-hover:bg-surface-secondary group-hover:text-text-strong":
              !props.active && !props.warn,
          }}
        >
          <Icon name={props.icon ?? "book"} size="large" class="scale-110" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <div
              class="min-w-0 truncate text-15-medium transition-colors"
              classList={{
                "text-text-danger-base": !!props.warn,
                "text-text-success-base": !props.warn,
              }}
            >
              {props.title}
            </div>
            <Show when={props.warnLabel}>
              <span class="shrink-0 rounded-full border border-border-danger-base/45 bg-surface-danger-base/15 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-danger-base">
                {props.warnLabel}
              </span>
            </Show>
          </div>
          <Show when={props.note}>
            <div
              class="mt-2 line-clamp-2 text-12-regular leading-5 transition-colors"
              classList={{
                "text-text-base": props.active,
                "text-text-weak": !props.active,
              }}
            >
              {props.note}
            </div>
          </Show>
        </div>
      </div>
      <Show when={props.deletable && props.onDelete}>
        <button
          type="button"
          class="ml-2 shrink-0 rounded-md p-1.5 transition-colors duration-150"
          classList={{
            "bg-surface-danger-base/15 text-text-danger-base hover:bg-surface-danger-base/25": confirmDelete(),
            "text-text-weak opacity-0 group-hover:opacity-100 hover:text-text-danger-base hover:bg-surface-secondary":
              !confirmDelete(),
          }}
          onClick={handleDeleteClick}
          aria-label={
            confirmDelete() ? language.t("config.skills.delete.confirm") : language.t("config.skills.delete.action")
          }
          title={
            confirmDelete() ? language.t("config.skills.delete.confirm") : language.t("config.skills.delete.action")
          }
        >
          <Show when={confirmDelete()} fallback={<Icon name="trash" size="small" />}>
            <span class="text-11-medium whitespace-nowrap">{language.t("config.skills.delete.confirm")}</span>
          </Show>
        </button>
      </Show>
    </button>
  )
}

function ConfigSearchBox(props: { value: string; placeholder: string; onInput: (value: string) => void }) {
  return (
    <div class="flex items-center gap-2.5 rounded-lg border border-border-weak-base bg-background-base px-3 py-2.5 transition-[border-color,box-shadow] focus-within:border-[color-mix(in_srgb,var(--surface-brand-base)_45%,var(--border-strong))] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--surface-brand-base)_10%,transparent)]">
      <Icon name="magnifying-glass" size="small" class="shrink-0 text-text-weak" />
      <input
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        class="min-w-0 flex-1 bg-transparent text-13-regular text-text-base outline-none placeholder:text-text-weak"
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </div>
  )
}

function ConfigPaneTitle(props: { title: string; description?: string; icon: IconProps["name"] }) {
  return (
    <div class="flex min-w-0 items-start gap-3">
      <div class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[color-mix(in_srgb,var(--surface-brand-base)_28%,var(--border-weak-base))] bg-[color-mix(in_srgb,var(--surface-brand-base)_12%,var(--background-base))] text-text-strong shadow-sm">
        <Icon name={props.icon} size="medium" />
      </div>
      <div class="min-w-0 pt-0.5">
        <div class="truncate text-18-medium text-text-strong">{props.title}</div>
        <Show when={props.description}>
          <div class="mt-1 line-clamp-2 text-12-regular leading-5 text-text-weak">{props.description}</div>
        </Show>
      </div>
    </div>
  )
}

function PluginListButton(props: {
  active: boolean
  title: string
  note?: string
  meta?: string
  warn?: boolean
  onClick: () => void
  extra?: JSX.Element
}) {
  const press = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    props.onClick()
  }

  return (
    <div
      role="button"
      tabIndex={0}
      class={CONFIG_MIDDLE_ITEM_CLASS}
      classList={{
        [CONFIG_MIDDLE_ITEM_ACTIVE_CLASS]: props.active,
        [CONFIG_MIDDLE_ITEM_INACTIVE_CLASS]: !props.active,
      }}
      onClick={props.onClick}
      onKeyDown={press}
    >
      <div class="flex min-w-0 flex-1 items-start gap-3">
        <div
          class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150"
          classList={{
            "bg-surface-danger-base/15 text-text-danger-base": !!props.warn,
            "bg-surface-secondary text-text-strong": props.active && !props.warn,
            "bg-surface-secondary/70 text-text-base group-hover:bg-surface-secondary group-hover:text-text-strong":
              !props.active && !props.warn,
          }}
        >
          <Icon name="code" size="small" />
        </div>
        <div class="min-w-0 flex-1">
          <div
            class="min-w-0 truncate text-15-medium transition-colors"
            classList={{
              "text-text-danger-base": !!props.warn,
              "text-text-info-base": !props.warn,
            }}
          >
            {props.title}
          </div>
          <Show when={props.note}>
            <div
              class="mt-2 line-clamp-2 text-12-regular leading-5 transition-colors"
              classList={{
                "text-text-base": props.active,
                "text-text-weak": !props.active,
              }}
            >
              {props.note}
            </div>
          </Show>
          <Show when={props.meta}>
            <div
              class="mt-2 break-all font-mono text-[12px] leading-5 transition-colors"
              classList={{
                "text-text-base": props.active,
                "text-text-weak": !props.active,
              }}
            >
              {props.meta}
            </div>
          </Show>
        </div>
      </div>
      <Show when={props.extra}>
        <div
          class="shrink-0 pt-0.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {props.extra}
        </div>
      </Show>
    </div>
  )
}

function ProjectListGroup(props: {
  label: string
  path?: string
  count: number
  open: boolean
  onToggle: () => void
  onAdd?: () => void
  addLabel?: string
  addDisabled?: boolean
  children: JSX.Element
}) {
  const press = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    props.onToggle()
  }
  const [addPressed, setAddPressed] = createSignal(false)

  return (
    <div class="relative overflow-hidden rounded-[14px] border border-border-weak-base/80 bg-background-base/65 shadow-[inset_0_1px_0_color-mix(in_srgb,white_5%,transparent)] transition-colors hover:border-border-base">
      <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--text-strong)_16%,transparent),transparent)]" />
      <div
        role="button"
        tabIndex={0}
        aria-expanded={props.open ? "true" : "false"}
        class="group flex w-full items-center justify-between gap-3 rounded-[13px] px-3.5 py-3 text-left transition-colors hover:bg-surface-base/55 focus:outline-none focus-visible:bg-surface-base-hover"
        classList={{
          "rounded-b-none border-b border-border-weak-base/70 bg-surface-base/40": props.open,
        }}
        onClick={props.onToggle}
        onKeyDown={press}
      >
        <div class="flex min-w-0 items-center gap-3">
          <div
            class="flex size-9 shrink-0 items-center justify-center rounded-xl text-text-base transition-colors"
            classList={{
              "bg-surface-secondary text-text-strong": props.open,
              "bg-surface-secondary/60 group-hover:bg-surface-secondary group-hover:text-text-strong": !props.open,
            }}
          >
            <Icon name="folder" size="small" />
          </div>
          <div class="min-w-0">
            <div class="truncate text-13-medium text-text-strong">{props.label}</div>
            <Show when={props.path}>
              <div class="mt-1 truncate font-mono text-[11px] leading-4 text-text-weak">{props.path}</div>
            </Show>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <div class="rounded-full border border-border-weak-base bg-surface-secondary px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
            {props.count}
          </div>
          <Show
            when={props.open && props.onAdd}
            fallback={
              <div class="flex size-7 items-center justify-center rounded-full border border-border-weak-base bg-background-base text-text-weak transition-colors group-hover:border-border-base group-hover:text-text-base">
                <Icon name={props.open ? "chevron-down" : "chevron-right"} size="small" />
              </div>
            }
          >
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-full border text-text-strong shadow-sm transition-all duration-150 ease-out hover:-translate-y-0.5 hover:scale-110 hover:shadow-md active:translate-y-0 active:scale-95 disabled:translate-y-0 disabled:scale-100 disabled:shadow-none disabled:border-border-weak-base disabled:bg-background-base disabled:text-text-weaker"
              classList={{
                "border-border-strong bg-surface-base-hover shadow-[0_0_0_3px_color-mix(in_srgb,var(--text-strong)_10%,transparent)]":
                  addPressed(),
                "border-border-base bg-surface-base-active": !addPressed(),
              }}
              onClick={(event) => {
                event.stopPropagation()
                props.onAdd?.()
              }}
              onPointerDown={(event) => {
                event.stopPropagation()
                setAddPressed(true)
              }}
              onPointerUp={(event) => {
                event.stopPropagation()
                setAddPressed(false)
              }}
              onPointerLeave={() => setAddPressed(false)}
              onPointerCancel={() => setAddPressed(false)}
              onBlur={() => setAddPressed(false)}
              disabled={props.addDisabled}
              aria-label={props.addLabel}
              title={props.addLabel}
            >
              <Icon name="plus-small" size="small" />
            </button>
          </Show>
        </div>
      </div>
      <Show when={props.open}>
        <div class="bg-surface-base/20 px-2 py-2">
          <div class="flex flex-col gap-2">{props.children}</div>
        </div>
      </Show>
    </div>
  )
}

function Wait(props: { text: string }) {
  return (
    <div class="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <Spinner class="size-4 text-icon-weak-base" />
      <div class="text-13-regular text-text-weak">{props.text}</div>
    </div>
  )
}

function Tree(props: {
  list: TreeNode[]
  root?: string
  depth?: number
  open: (path: string) => boolean
  toggle: (path: string) => void
}) {
  return (
    <div class="flex flex-col gap-1.5">
      <For each={props.list}>
        {(item, idx) => (
          <div class="relative flex flex-col gap-1">
            <Show when={(props.depth ?? 0) > 0}>
              <div
                class="pointer-events-none absolute left-3 top-0 bottom-0 border-l border-border-weak-base/60"
                style={{ left: `${3 + (props.depth ?? 0) * 14}px` }}
              />
              <div
                class="pointer-events-none absolute top-[18px] h-px bg-border-weak-base/60"
                style={{
                  left: `${3 + (props.depth ?? 0) * 14}px`,
                  width: "14px",
                }}
              />
            </Show>
            <div
              class="relative flex items-center gap-2 rounded-lg px-2.5 py-2 text-left"
              style={{ "padding-left": `${(props.depth ?? 0) * 14}px` }}
            >
              <Show
                when={item.kind === "directory" && item.kids.length > 0}
                fallback={
                  <Show when={(props.depth ?? 0) > 0}>
                    <div class="size-3 shrink-0" />
                  </Show>
                }
              >
                <button
                  type="button"
                  class="flex size-3 shrink-0 items-center justify-center text-text-weak transition-colors hover:text-text-base"
                  onClick={() => props.toggle(item.path)}
                >
                  <Icon name={props.open(item.path) ? "chevron-down" : "chevron-right"} size="small" />
                </button>
              </Show>
              <TreeGlyph path={item.path} kind={item.kind} />
              <div
                class="min-w-0 truncate text-12-regular text-text-base"
                classList={{
                  "cursor-pointer": item.kind === "directory" && item.kids.length > 0,
                }}
                onClick={() => {
                  if (item.kind !== "directory" || item.kids.length === 0) return
                  props.toggle(item.path)
                }}
              >
                {props.depth ? name(item.path) : short(item.path, props.root)}
              </div>
            </div>
            <Show when={item.kids.length > 0 && props.open(item.path)}>
              <div class="relative">
                <Show when={idx() !== props.list.length - 1}>
                  <div
                    class="pointer-events-none absolute left-3 top-0 bottom-0 border-l border-border-weak-base/60"
                    style={{ left: `${17 + (props.depth ?? 0) * 14}px` }}
                  />
                </Show>
                <Tree
                  list={item.kids}
                  root={props.root}
                  depth={(props.depth ?? 0) + 1}
                  open={props.open}
                  toggle={props.toggle}
                />
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}

function MarkdownField(props: {
  text: string
  busy: boolean
  editable: boolean
  onInput: (value: string) => void
  paint?: (value: string) => string
  preview?: boolean
}) {
  const settings = useSettings()
  const language = useLanguage()
  const [mode, setMode] = createSignal<"source" | "preview">("source")
  let box: HTMLTextAreaElement | undefined
  let back: HTMLDivElement | undefined
  const html = createMemo(() => (props.paint ?? paint)(props.text))
  const font = createMemo(() => monoFontFamily(settings.appearance.font()))
  const previewMode = createMemo(() => props.preview && mode() === "preview")

  const sync = () => {
    if (!box || !back) return
    back.scrollTop = box.scrollTop
    back.scrollLeft = box.scrollLeft
  }

  const applyEdit = (next: { text: string; start: number; end: number }) => {
    props.onInput(next.text)
    requestAnimationFrame(() => {
      if (!box) return
      box.setSelectionRange(next.start, next.end)
      sync()
    })
  }

  const onKeyDown: JSX.EventHandlerUnion<HTMLTextAreaElement, KeyboardEvent> = (event) => {
    if (!props.editable) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.isComposing || event.keyCode === 229) return

    if (event.key === "Tab") {
      const next = indent({
        text: props.text,
        start: event.currentTarget.selectionStart ?? 0,
        end: event.currentTarget.selectionEnd ?? 0,
        shiftKey: event.shiftKey,
      })
      event.preventDefault()
      if (next) applyEdit(next)
      return
    }

    const next = pair({
      text: props.text,
      start: event.currentTarget.selectionStart ?? 0,
      end: event.currentTarget.selectionEnd ?? 0,
      key: event.key,
    })
    if (!next) return
    event.preventDefault()
    applyEdit(next)
  }

  createEffect(() => {
    props.text
    requestAnimationFrame(sync)
  })

  createEffect(() => {
    if (!props.preview && mode() !== "source") setMode("source")
  })

  return (
    <div class="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border-weak-base bg-background-base">
      <Show when={props.preview}>
        <ConfigEditorModeToggle mode={mode()} onMode={setMode} />
      </Show>
      <Show
        when={previewMode()}
        fallback={
          <div class="relative min-h-0 flex-1 overflow-hidden">
            <div
              ref={(el) => {
                back = el
              }}
              aria-hidden="true"
              class="config-scrollbar pointer-events-none absolute inset-0 overflow-auto px-4 py-3 text-13-mono leading-6 whitespace-pre-wrap break-words"
              style={{ "font-family": font() }}
            >
              <div class="min-h-full w-full" innerHTML={html()} />
            </div>
            <Show when={props.busy}>
              <div class="pointer-events-none absolute left-4 top-3 z-10 text-12-regular text-text-weak">
                {language.t("config.editor.loadingFile")}
              </div>
            </Show>
            <textarea
              ref={(el) => {
                box = el
              }}
              class="config-scrollbar absolute inset-0 size-full min-h-0 resize-none overflow-auto bg-transparent px-4 py-3 text-13-mono leading-6 focus:outline-none"
              style={{
                color: "transparent",
                "-webkit-text-fill-color": "transparent",
                "caret-color": "var(--text-strong)",
                "font-family": font(),
              }}
              spellcheck={false}
              readOnly={!props.editable}
              value={props.text}
              onInput={(event) => props.onInput(event.currentTarget.value)}
              onScroll={sync}
              onKeyDown={onKeyDown}
            />
          </div>
        }
      >
        <div class="config-scrollbar min-h-0 flex-1 overflow-auto px-5 py-4">
          <Markdown text={props.text} math="full" highlight="defer" class="text-13-regular leading-6" />
        </div>
      </Show>
    </div>
  )
}

type ConfigEditorMode = "source" | "preview"

function ConfigEditorModeToggle(props: { mode: ConfigEditorMode; onMode: (mode: ConfigEditorMode) => void }) {
  const language = useLanguage()

  return (
    <div class="config-editor-mode-toggle">
      <div role="group" class="config-editor-mode-toggle__group">
        <button
          type="button"
          class="config-editor-mode-toggle__button"
          data-active={props.mode === "source" ? "true" : undefined}
          onClick={() => props.onMode("source")}
        >
          <Icon name="edit" size="small" />
          {language.t("trellis.tasks.edit")}
        </button>
        <button
          type="button"
          class="config-editor-mode-toggle__button"
          data-active={props.mode === "preview" ? "true" : undefined}
          onClick={() => props.onMode("preview")}
        >
          <Icon name="eye" size="small" />
          {language.t("trellis.tasks.preview")}
        </button>
      </div>
    </div>
  )
}

function SaveButton(props: {
  label: string
  disabled?: boolean
  icon?: "save" | "check-small"
  size?: "small" | "large"
  onClick: () => void
}) {
  return (
    <Button
      size={props.size ?? "small"}
      variant="secondary"
      icon={props.icon ?? "save"}
      onClick={props.onClick}
      disabled={props.disabled}
      class="config-save-button"
      data-config-save-state={props.disabled ? "disabled" : "active"}
    >
      {props.label}
    </Button>
  )
}

function Editor(props: {
  item?: DocItem
  text: string
  dirty: boolean
  busy: boolean
  tree?: TreeNode[]
  treeRoot?: string
  treeBusy?: boolean
  treeOpen?: (path: string) => boolean
  onTreeToggle?: (path: string) => void
  onInput: (value: string) => void
  onSave: () => void
  onOpenFolder?: () => void
  onCopyPath?: () => void
  copyPathCopied?: boolean
  onDelete?: () => void
  extra?: JSX.Element
  warn?: string
  empty: string
  markdown?: boolean
}) {
  const language = useLanguage()
  const settings = useSettings()
  const font = createMemo(() => monoFontFamily(settings.appearance.font()))
  const source = createMemo(() => sourceKey(props.item?.source))
  const canSave = createMemo(() => !!props.item?.editable && props.dirty)

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="border-b border-border-weak-base px-5 py-4">
        <div class="min-w-0">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <div class="truncate text-20-medium text-text-strong">
                  {props.item?.label ?? language.t("config.editor.selectItem")}
                </div>
                <Show when={props.item?.editable !== undefined}>
                  <span class="shrink-0 rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                    {props.item?.editable
                      ? language.t("config.editor.badge.editable")
                      : language.t("config.editor.badge.readOnly")}
                  </span>
                </Show>
                <Show when={source()}>
                  <span class="shrink-0 rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                    {language.t(source()!)}
                  </span>
                </Show>
              </div>
            </div>
            <div class="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <Show when={props.extra}>
                <div>{props.extra}</div>
              </Show>
              <Show when={props.onOpenFolder}>
                <Button size="small" variant="ghost" onClick={props.onOpenFolder}>
                  <Icon name="folder" size="small" class="shrink-0" />
                  {language.t("config.action.openFolder")}
                </Button>
              </Show>
              <Show when={props.onDelete}>
                {(onDelete) => (
                  <Button
                    size="small"
                    variant="ghost"
                    icon="trash"
                    onClick={onDelete()}
                    disabled={!props.item?.editable || props.busy}
                  >
                    {language.t("config.action.delete")}
                  </Button>
                )}
              </Show>
              <SaveButton
                icon="check-small"
                onClick={props.onSave}
                disabled={!canSave()}
                label={language.t("common.save")}
              />
            </div>
          </div>
          <div class="mt-1 break-all font-mono text-[12px] leading-5 text-text-weak">
            {props.item?.path ?? ""}
            <Show when={props.onCopyPath && props.item?.path}>
              <IconButton
                icon={props.copyPathCopied ? "check" : "copy"}
                variant="ghost"
                size="small"
                class="ml-1 inline-flex translate-y-[1px] align-middle text-text-weak hover:bg-surface-base-hover hover:text-text-base active:bg-surface-base-active"
                aria-label={language.t("session.header.open.copyPath")}
                onClick={props.onCopyPath}
              />
            </Show>
          </div>
          <Show when={props.item?.note}>
            <div class="mt-2 text-12-regular text-text-weak">{props.item?.note}</div>
          </Show>
          <Show when={props.warn}>
            <div class="mt-3 rounded-xl border border-border-weak-base bg-surface-secondary px-3 py-2 text-12-regular text-text-danger-base">
              {props.warn}
            </div>
          </Show>
        </div>
      </div>
      <Show when={props.item} fallback={<div class="px-5 py-10 text-13-regular text-text-weak">{props.empty}</div>}>
        <div
          class="grid min-h-0 flex-1 auto-rows-fr gap-4 px-5 py-4"
          classList={{
            "xl:grid-cols-[minmax(0,1fr)_280px]": !!props.treeRoot,
          }}
        >
          <div class="min-h-0">
            <Show
              when={props.markdown}
              fallback={
                <div class="flex h-full min-h-0 flex-col rounded-xl border border-border-weak-base bg-background-base p-3">
                  <Show when={props.busy} fallback={null}>
                    <div class="mb-3 text-12-regular text-text-weak">{language.t("config.editor.loadingFile")}</div>
                  </Show>
                  <Show
                    when={script(props.item?.path)}
                    fallback={
                      <textarea
                        class="size-full min-h-0 flex-1 resize-none bg-transparent p-1 text-13-mono text-text-base outline-none"
                        style={{ "font-family": font() }}
                        spellcheck={false}
                        readOnly={!props.item?.editable}
                        value={props.text}
                        onInput={(event) => props.onInput(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (!props.item?.editable) return
                          handleTextareaIndent(event, props.text, (next) => props.onInput(next.text))
                        }}
                      />
                    }
                  >
                    <MarkdownField
                      text={props.text}
                      busy={props.busy}
                      editable={!!props.item?.editable}
                      onInput={props.onInput}
                      paint={paintCode}
                    />
                  </Show>
                </div>
              }
            >
              <MarkdownField
                text={props.text}
                busy={props.busy}
                editable={!!props.item?.editable}
                onInput={props.onInput}
                paint={paint}
                preview
              />
            </Show>
          </div>
          <Show when={props.treeRoot}>
            <div class="flex h-full min-h-0 flex-col rounded-xl border border-border-weak-base bg-background-base p-3">
              <div class="mb-3 text-11-medium uppercase tracking-[0.08em] text-text-weak">
                {language.t("config.editor.structure")}
              </div>
              <Show when={props.treeBusy}>
                <div class="mb-3 text-12-regular text-text-weak">{language.t("config.editor.loadingStructure")}</div>
              </Show>
              <Show
                when={(props.tree ?? []).length > 0}
                fallback={<div class="text-12-regular text-text-weak">{language.t("config.editor.noFiles")}</div>}
              >
                <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
                  <Tree
                    list={props.tree ?? []}
                    root={props.treeRoot}
                    open={props.treeOpen ?? (() => true)}
                    toggle={props.onTreeToggle ?? (() => undefined)}
                  />
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function ProviderDetail(props: {
  item?: ProviderItem
  busy: boolean
  onToggle: (item: ProviderItem, enabled: boolean) => void
  onSignOut: (item: ProviderItem) => void
}) {
  const language = useLanguage()
  const settings = useSettings()

  const canSignOut = () => canSignOutProvider(props.item)

  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show
        when={props.item}
        fallback={<div class="px-4 py-10 text-13-regular text-text-weak">{language.t("config.provider.select")}</div>}
      >
        <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border-weak-base px-4 py-4">
          <div>
            <div class="flex items-center gap-2">
              <div class="text-20-medium text-text-strong">{props.item?.id}</div>
              <Show when={props.item}>
                <span class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                  {providerEnabled(props.item)
                    ? language.t("config.provider.badge.enabled")
                    : language.t("config.provider.badge.known")}
                </span>
              </Show>
              <Show when={sourceKey(props.item?.source)}>
                <span class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                  {language.t(sourceKey(props.item?.source)!)}
                </span>
              </Show>
              <Show when={props.item?.sdk}>
                <span class="rounded-full bg-surface-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-weak">
                  {props.item?.sdk}
                </span>
              </Show>
              <span class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                {language.t("config.provider.modelsCount", { count: props.item?.models.length ?? 0 })}
              </span>
            </div>
            <div class="mt-2 text-12-regular text-text-weak">
              {props.item?.custom
                ? props.item?.allowed
                  ? language.t("config.provider.customEnabled")
                  : language.t("config.provider.customDisabled")
                : props.item?.connected
                  ? props.item?.source === "env"
                    ? language.t("config.provider.envConnected")
                    : language.t("config.provider.connected")
                  : !props.item?.allowed
                    ? language.t("config.provider.disabled")
                    : language.t("config.provider.known")}
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Show
              when={!props.item?.custom}
              fallback={
                <Toggle
                  checked={!!props.item?.allowed}
                  disabled={props.busy}
                  onChange={(value) => props.item && props.onToggle(props.item, value)}
                >
                  {language.t("config.provider.toggle.enabledInConfig")}
                </Toggle>
              }
            >
              <Show when={props.item?.source !== "env"}>
                <Button
                  size="large"
                  variant="secondary"
                  disabled={props.busy}
                  onClick={() => {
                    const item = props.item
                    if (!item) return
                    const enable = !item.connected
                    console.log(
                      `[config] builtin provider action id=${item.id} connected=${String(item.connected)} allowed=${String(item.allowed)} enable=${String(enable)}`,
                    )
                    props.onToggle(item, enable)
                  }}
                >
                  {props.item?.connected
                    ? language.t("config.provider.toggle.disable")
                    : !props.item?.allowed
                      ? language.t("config.provider.toggle.enable")
                      : language.t("common.connect")}
                </Button>
              </Show>
              <Show when={canSignOut()}>
                <Button
                  size="large"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() => {
                    const item = props.item
                    if (!item) return
                    console.log(`[config] sign out provider id=${item.id} source=${item.source ?? ""}`)
                    props.onSignOut(item)
                  }}
                >
                  {language.t("config.provider.signOut")}
                </Button>
              </Show>
            </Show>
          </div>
        </div>
        <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          <div class="mb-3 text-11-medium uppercase tracking-[0.08em] text-text-weak">
            {language.t("config.provider.modelsTitle")}
          </div>
          <Show
            when={(props.item?.models.length ?? 0) > 0}
            fallback={
              <div class="rounded-xl border border-border-weak-base bg-background-base px-4 py-6 text-12-regular text-text-weak">
                {language.t("config.provider.noModels")}
              </div>
            }
          >
            <div class="grid gap-2">
              <For each={props.item?.models ?? []}>
                {(item, idx) => (
                  <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-xl border border-border-weak-base bg-background-base px-3 py-3">
                    <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                      {String(idx() + 1).padStart(2, "0")}
                    </div>
                    <div class="min-w-0 break-all font-mono text-[12px] leading-5 text-text-base">{item}</div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function ClawFormActions(props: {
  dirty: boolean
  busy: boolean
  canTest: boolean
  canDetect?: boolean
  saving: boolean
  testing: boolean
  detecting?: boolean
  onSave: () => void
  onTest: () => void
  onDetect?: () => void
  onAbort?: () => void
}) {
  const language = useLanguage()

  return (
    <div class="flex flex-wrap items-center justify-end gap-2">
      <Show when={props.canDetect && props.onDetect}>
        <Button
          size="small"
          variant="ghost"
          icon="magnifying-glass"
          onClick={() => props.onDetect?.()}
          disabled={props.busy || props.saving || props.testing || props.detecting}
        >
          <Show when={props.detecting} fallback={language.t("config.claws.action.detect")}>
            <span class="inline-flex items-center gap-2">
              <Spinner class="size-3" />
              {language.t("config.claws.action.detecting")}
            </span>
          </Show>
        </Button>
      </Show>
      <Button
        size="small"
        variant="ghost"
        icon="reset"
        onClick={props.onTest}
        disabled={!props.canTest || props.busy || props.saving || props.testing || props.detecting}
      >
        {language.t("config.claws.action.test")}
      </Button>
      <Show when={props.testing && props.onAbort}>
        <Button size="small" variant="ghost" icon="stop" onClick={() => props.onAbort?.()}>
          {language.t("config.claws.action.abort")}
        </Button>
      </Show>
      <SaveButton
        label={language.t("config.claws.action.save")}
        onClick={props.onSave}
        disabled={props.busy || props.saving || props.testing || props.detecting || !props.dirty}
      />
    </div>
  )
}

function ClawHeader(props: {
  item?: ClawItem
  enabled: boolean
  busy: boolean
  saving: boolean
  testing: boolean
  onEnabled: (value: boolean) => void
}) {
  const language = useLanguage()

  return (
    <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border-weak-base px-4 py-4">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <div class="text-20-medium text-text-strong">{props.item?.label}</div>
          <span class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
            {props.enabled ? language.t("config.claws.badge.enabled") : language.t("config.claws.badge.disabled")}
          </span>
        </div>
        <Show when={props.item?.sourceUrl}>
          {(sourceUrl) => (
            <div class="mt-2 break-all font-mono text-[12px] leading-5 text-text-weak">
              <span>{language.t("config.claws.source.github")}: </span>
              <Link href={sourceUrl()} class="text-text-base">
                {sourceUrl()}
              </Link>
            </div>
          )}
        </Show>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Toggle
          checked={props.enabled}
          disabled={props.busy || props.saving || props.testing}
          onChange={props.onEnabled}
        >
          {language.t("config.claws.field.enabled")}
        </Toggle>
      </div>
    </div>
  )
}

function ExtraAgentInfoCard(props: { info?: ExtraAgentInfo; loading?: boolean }) {
  const language = useLanguage()

  const value = (input?: string) => input?.trim() || language.t("config.claws.info.unknown")

  return (
    <div class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="text-13-medium text-text-strong">{language.t("config.claws.info.title")}</div>
        <Show when={props.loading}>
          <div
            class="inline-flex items-center gap-1.5 text-12-regular text-text-weak"
            title={language.t("config.claws.info.refreshing")}
          >
            <Icon name="refresh" size="small" class="animate-spin" />
            <span>{language.t("config.claws.info.loading")}</span>
          </div>
        </Show>
      </div>
      <div class="mt-4 grid gap-3 md:grid-cols-2">
        <InfoCell label={language.t("config.claws.info.localVersion")} value={value(props.info?.localVersion)} />
        <InfoCell label={language.t("config.claws.info.latestVersion")} value={value(props.info?.latestVersion)} />
      </div>
    </div>
  )
}

function InfoCell(props: { label: string; value: string }) {
  return (
    <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2">
      <div class="text-10-medium uppercase tracking-[0.08em] text-text-weak">{props.label}</div>
      <div class="mt-1 break-all font-mono text-12-regular text-text-base">{props.value}</div>
    </div>
  )
}

function ClawEditor(props: {
  item?: ClawItem
  info?: ExtraAgentInfo
  infoLoading?: boolean
  form: ReturnType<typeof clawCfg>
  dirty: boolean
  busy: boolean
  canTest: boolean
  canDetect: boolean
  onChange: (key: "enabled" | "url" | "token", value: string | boolean) => void
  onSave: () => void
  onTest: () => void
  onDetect: () => void
  onAbort?: () => void
}) {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show
        when={props.item}
        fallback={<div class="px-4 py-10 text-13-regular text-text-weak">{language.t("config.claws.empty")}</div>}
      >
        <ClawHeader
          item={props.item}
          enabled={props.form.enabled}
          busy={props.busy}
          saving={props.form.saving}
          testing={props.form.testing}
          onEnabled={(value) => props.onChange("enabled", value)}
        />

        <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          <div class="flex w-full flex-col gap-6">
            <Show when={props.infoLoading || props.info}>
              <ExtraAgentInfoCard info={props.info} loading={props.infoLoading} />
            </Show>

            <div class="grid gap-4 lg:grid-cols-2">
              <TextField
                type="text"
                label={language.t("config.claws.field.url")}
                description={language.t("config.claws.field.urlDescription")}
                placeholder="ws://127.0.0.1:18789"
                value={props.form.url}
                validationState={props.form.err.url ? "invalid" : undefined}
                error={props.form.err.url}
                disabled={props.busy || props.form.saving || props.form.testing}
                onChange={(value) => props.onChange("url", value)}
              />
              <TextField
                type="password"
                label={language.t("config.claws.field.token")}
                description={language.t("config.claws.field.tokenDescription")}
                placeholder={language.t("config.claws.field.tokenPlaceholder")}
                value={props.form.token}
                disabled={props.busy || props.form.saving || props.form.testing}
                onChange={(value) => props.onChange("token", value)}
              />
            </div>

            <ClawFormActions
              dirty={props.dirty}
              busy={props.busy}
              canTest={props.canTest}
              canDetect={props.canDetect}
              saving={props.form.saving}
              testing={props.form.testing}
              detecting={props.form.detecting}
              onSave={props.onSave}
              onTest={props.onTest}
              onDetect={props.onDetect}
              onAbort={props.onAbort}
            />

            <Show when={props.form.testing || !!props.form.test}>
              <div class="rounded-2xl border border-border-weak-base bg-surface-base p-5">
                <div class="text-13-medium text-text-strong">{language.t("config.claws.debug.title")}</div>
                <div class="mt-1 text-12-regular text-text-weak">{language.t("config.claws.debug.description")}</div>
                <div class="mt-4 rounded-xl border border-border-weak-base bg-background-base px-4 py-3">
                  <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                    {language.t("config.claws.debug.status")}
                  </div>
                  <Show
                    when={props.form.testing}
                    fallback={
                      <div
                        class="mt-2 text-13-medium"
                        classList={{
                          "text-text-success": !!props.form.test?.ok,
                          "text-text-danger-base": !props.form.test?.ok,
                        }}
                      >
                        {props.form.test?.ok
                          ? language.t("config.claws.status.success")
                          : language.t("config.claws.status.failed")}
                      </div>
                    }
                  >
                    <div class="mt-2 inline-flex items-center gap-2 text-13-medium text-text-base">
                      <Spinner class="size-4" />
                      <span>{language.t("config.claws.status.testing")}</span>
                    </div>
                  </Show>
                </div>
                <div class="mt-4 rounded-xl border border-border-weak-base bg-background-base px-4 py-3">
                  <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                    {language.t("config.claws.debug.logs")}
                  </div>
                  <pre
                    class="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-12-regular text-text-weak"
                    style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
                  >
                    {props.form.testing
                      ? language.t("config.claws.logs.testing", { url: props.form.url.trim() || "-" })
                      : props.form.test?.logs.join("\n") || ""}
                  </pre>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

function GenericAgentEditor(props: {
  item?: ClawItem
  info?: ExtraAgentInfo
  infoLoading?: boolean
  form: ReturnType<typeof gaCfg>
  dirty: boolean
  busy: boolean
  canTest: boolean
  onChange: (key: "enabled" | "pythonExecutable" | "genericAgentDir", value: string | boolean) => void
  onChooseDir: () => void
  onSave: () => void
  onTest: () => void
  onAbort?: () => void
}) {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show
        when={props.item}
        fallback={<div class="px-4 py-10 text-13-regular text-text-weak">{language.t("config.claws.empty")}</div>}
      >
        <ClawHeader
          item={props.item}
          enabled={props.form.enabled}
          busy={props.busy}
          saving={props.form.saving}
          testing={props.form.testing}
          onEnabled={(value) => props.onChange("enabled", value)}
        />

        <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          <div class="flex w-full flex-col gap-6">
            <Show when={props.infoLoading || props.info}>
              <ExtraAgentInfoCard info={props.info} loading={props.infoLoading} />
            </Show>

            <div class="grid gap-4 lg:grid-cols-2">
              <div class="min-w-0">
                <div class="mb-1.5 flex min-w-0 items-center justify-between gap-3">
                  <div class="min-w-0 truncate text-14-medium text-text-base">
                    {language.t("config.claws.field.genericAgentDir")}
                  </div>
                  <Button
                    size="small"
                    variant="secondary"
                    icon="folder-add-left"
                    onClick={props.onChooseDir}
                    disabled={props.busy || props.form.saving || props.form.testing}
                  >
                    {language.t("session.new.genericagent.cwd.choose")}
                  </Button>
                </div>
                <TextField
                  type="text"
                  hideLabel
                  label={language.t("config.claws.field.genericAgentDir")}
                  placeholder={language.t("config.claws.field.genericAgentDirPlaceholder")}
                  value={props.form.genericAgentDir}
                  validationState={props.form.err.genericAgentDir ? "invalid" : undefined}
                  disabled={props.busy || props.form.saving || props.form.testing}
                  onChange={(value) => props.onChange("genericAgentDir", value)}
                />
                <Show
                  when={props.form.err.genericAgentDir}
                  fallback={
                    <div class="mt-2 text-12-regular text-text-weak">
                      {language.t("config.claws.field.genericAgentDirDescription")}
                    </div>
                  }
                >
                  {(error) => <div class="mt-2 text-12-regular text-text-danger-base">{error()}</div>}
                </Show>
              </div>
              <TextField
                type="text"
                label={language.t("config.claws.field.pythonExecutable")}
                description={language.t("config.claws.field.pythonExecutableDescription")}
                placeholder={language.t("config.claws.field.pythonExecutablePlaceholder")}
                value={props.form.pythonExecutable}
                disabled={props.busy || props.form.saving || props.form.testing}
                onChange={(value) => props.onChange("pythonExecutable", value)}
              />
            </div>

            <ClawFormActions
              dirty={props.dirty}
              busy={props.busy}
              canTest={props.canTest}
              saving={props.form.saving}
              testing={props.form.testing}
              onSave={props.onSave}
              onTest={props.onTest}
              onAbort={props.onAbort}
            />

            <Show when={props.form.testing || !!props.form.test}>
              <div class="rounded-2xl border border-border-weak-base bg-surface-base p-5">
                <div class="text-13-medium text-text-strong">{language.t("config.claws.debug.title")}</div>
                <div class="mt-1 text-12-regular text-text-weak">{language.t("config.claws.debug.description")}</div>
                <div class="mt-4 rounded-xl border border-border-weak-base bg-background-base px-4 py-3">
                  <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                    {language.t("config.claws.debug.status")}
                  </div>
                  <Show
                    when={props.form.testing}
                    fallback={
                      <div
                        class="mt-2 text-13-medium"
                        classList={{
                          "text-text-success": !!props.form.test?.ok,
                          "text-text-danger-base": !props.form.test?.ok,
                        }}
                      >
                        {props.form.test?.ok
                          ? language.t("config.claws.status.success")
                          : language.t("config.claws.status.failed")}
                      </div>
                    }
                  >
                    <div class="mt-2 inline-flex items-center gap-2 text-13-medium text-text-base">
                      <Spinner class="size-4" />
                      <span>{language.t("config.claws.status.testing")}</span>
                    </div>
                  </Show>
                </div>
                <div class="mt-4 rounded-xl border border-border-weak-base bg-background-base px-4 py-3">
                  <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                    {language.t("config.claws.debug.logs")}
                  </div>
                  <pre
                    class="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-12-regular text-text-weak"
                    style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
                  >
                    {props.form.testing
                      ? language.t("config.claws.logs.testingGa", {
                          dir: props.form.genericAgentDir.trim() || "-",
                        })
                      : props.form.test?.logs.join("\n") || ""}
                  </pre>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

function CliAgentInfoCard(props: { descriptor: CliAgentDescriptor; info?: CliAgentInfo; loading?: boolean }) {
  const language = useLanguage()
  const value = (input?: string) => {
    if (input === undefined || input === null || input === "") return language.t("config.claws.info.unknown")
    return String(input)
  }
  const install = () => {
    if (props.loading && !props.info) return language.t("config.claws.info.loading")
    if (!props.info) return language.t("config.claws.info.unknown")
    return props.info.installed ? language.t("config.claws.status.success") : language.t("config.claws.status.failed")
  }

  return (
    <div class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="text-13-medium text-text-strong">{props.descriptor.label}</div>
        <Show when={props.loading}>
          <div
            class="inline-flex items-center gap-1.5 text-12-regular text-text-weak"
            title={language.t("config.claws.info.refreshing")}
          >
            <Icon name="refresh" size="small" class="animate-spin" />
            <span>{language.t("config.claws.info.loading")}</span>
          </div>
        </Show>
      </div>
      <div class="mt-4 grid gap-3 md:grid-cols-2">
        <InfoCell label={language.t("config.claws.info.installStatus")} value={install()} />
        <InfoCell label={language.t("config.claws.info.version")} value={value(props.info?.version)} />
        <InfoCell label={language.t("config.claws.info.binaryPath")} value={value(props.info?.binaryPath)} />
        <InfoCell label={props.descriptor.configHomeLabel} value={value(props.info?.configHome)} />
        <InfoCell label={language.t("config.claws.info.configPath")} value={value(props.info?.configPath)} />
        <For each={props.info?.details ?? []}>{(detail) => <InfoCell label={detail.label} value={detail.value} />}</For>
      </div>
      <Show when={props.info?.error}>
        {(error) => <div class="mt-3 text-12-regular text-text-danger-base">{error()}</div>}
      </Show>
    </div>
  )
}

function shortPluginName(name?: string, id?: string) {
  if (name?.trim()) {
    const parts = name.split("/")
    return parts[parts.length - 1] || name
  }
  return id || ""
}

function isPluginHardDisabled(plugin: DshPluginEntry) {
  return plugin.disabled === true
}

function isPluginConditionallyDisabled(plugin: DshPluginEntry) {
  return typeof plugin.disabled === "string" && plugin.disabled.length > 0
}

function DshPluginInventoryCard(props: {
  inventory?: DshPluginInventory
  loading?: boolean
  togglingId?: string
  query: string
  showDisabled: boolean
  expandedId?: string
  canLoad: boolean
  canToggle: boolean
  onQuery: (value: string) => void
  onToggleDisabled: (value: boolean) => void
  onExpand: (id?: string) => void
  onLoad: () => void
  onSetEnabled?: (id: string, enabled: boolean) => void
}) {
  const language = useLanguage()
  const filtered = createMemo(() => {
    const inventory = props.inventory
    if (!inventory) return [] as DshPluginEntry[]
    const query = props.query.trim().toLowerCase()
    return inventory.plugins.filter((plugin) => {
      if (!props.showDisabled && isPluginHardDisabled(plugin)) return false
      if (!query) return true
      const haystack = [plugin.id, plugin.name, plugin.source, plugin.configPreview]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return haystack.includes(query)
    })
  })
  const enabledCount = createMemo(
    () => props.inventory?.plugins.filter((plugin) => !isPluginHardDisabled(plugin)).length ?? 0,
  )
  const disabledCount = createMemo(
    () => props.inventory?.plugins.filter((plugin) => isPluginHardDisabled(plugin)).length ?? 0,
  )

  return (
    <div class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-13-medium text-text-strong">{language.t("config.claws.dsh.plugins.title")}</div>
          <div class="mt-1 text-12-regular text-text-weak">{language.t("config.claws.dsh.plugins.description")}</div>
        </div>
        <Button
          size="small"
          variant="secondary"
          icon="refresh"
          disabled={!props.canLoad || props.loading}
          onClick={props.onLoad}
        >
          {props.loading ? language.t("config.claws.dsh.plugins.loading") : language.t("config.claws.dsh.plugins.load")}
        </Button>
      </div>

      <Show when={props.inventory || props.loading}>
        <div class="mt-4 flex flex-wrap items-center gap-3 text-12-regular text-text-weak">
          <span>
            {language.t("config.claws.dsh.plugins.summary", {
              total: String(props.inventory?.plugins.length ?? 0),
              enabled: String(enabledCount()),
              disabled: String(disabledCount()),
              profile: props.inventory?.profile ?? "headless",
            })}
          </span>
          <Show when={props.inventory?.sources?.length}>
            <span>
              {language.t("config.claws.dsh.plugins.sources", {
                sources: (props.inventory?.sources ?? []).slice(0, 4).join(" · "),
              })}
            </span>
          </Show>
        </div>
      </Show>

      <Show when={props.inventory?.error}>
        {(error) => <div class="mt-3 text-12-regular text-text-danger-base">{error()}</div>}
      </Show>

      <Show when={props.inventory && !props.inventory.error}>
        <div class="mt-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
          <TextField
            type="text"
            label={language.t("config.claws.dsh.plugins.search")}
            description={language.t("config.claws.dsh.plugins.searchDescription")}
            placeholder={language.t("config.claws.dsh.plugins.searchPlaceholder")}
            value={props.query}
            disabled={props.loading}
            onChange={props.onQuery}
          />
          <label class="inline-flex items-center gap-2 pb-2 text-13-regular text-text-base">
            <input
              type="checkbox"
              checked={props.showDisabled}
              disabled={props.loading}
              onChange={(event) => props.onToggleDisabled(event.currentTarget.checked)}
            />
            {language.t("config.claws.dsh.plugins.showDisabled")}
          </label>
        </div>

        <div class="mt-4 max-h-[28rem] overflow-y-auto">
          <Show
            when={filtered().length > 0}
            fallback={
              <div class="rounded-xl border border-border-weak-base px-4 py-6 text-12-regular text-text-weak">
                {language.t("config.claws.dsh.plugins.empty")}
              </div>
            }
          >
            <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <For each={filtered()}>
                {(plugin) => {
                  const open = () => props.expandedId === plugin.id
                  const hardDisabled = () => isPluginHardDisabled(plugin)
                  const conditional = () => isPluginConditionallyDisabled(plugin)
                  const busy = () => props.togglingId === plugin.id || props.loading
                  const badge = () => {
                    if (hardDisabled()) return language.t("config.claws.dsh.plugins.badge.disabled")
                    if (conditional()) return language.t("config.claws.dsh.plugins.badge.conditional")
                    return language.t("config.claws.dsh.plugins.badge.enabled")
                  }
                  return (
                    <div
                      class="min-w-0 overflow-hidden rounded-[10px] border border-border-weak-base bg-background-base"
                      classList={{ "border-border-strong-base shadow-sm": open() }}
                    >
                      <div class="flex items-center gap-2 px-3 py-2.5">
                        <button
                          type="button"
                          class="min-w-0 flex-1 text-left"
                          onClick={() => props.onExpand(open() ? undefined : plugin.id)}
                        >
                          <div class="truncate text-13-medium text-text-strong" title={plugin.name || plugin.id}>
                            {shortPluginName(plugin.name, plugin.id)}
                          </div>
                          <div class="mt-0.5 truncate text-11-regular text-text-weak" title={plugin.id}>
                            {plugin.id}
                          </div>
                        </button>
                        <span
                          class="shrink-0 rounded-full px-2 py-0.5 text-11-medium"
                          classList={{
                            "bg-surface-secondary text-text-success-base": !hardDisabled() && !conditional(),
                            "bg-surface-danger-base/15 text-text-danger-base": hardDisabled(),
                            "bg-surface-secondary text-text-weak": conditional() && !hardDisabled(),
                          }}
                        >
                          {badge()}
                        </span>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={!props.canToggle || busy() || conditional()}
                          onClick={() => props.onSetEnabled?.(plugin.id, hardDisabled())}
                        >
                          {busy()
                            ? language.t("config.claws.dsh.plugins.toggling")
                            : hardDisabled()
                              ? language.t("config.claws.dsh.plugins.enable")
                              : language.t("config.claws.dsh.plugins.disable")}
                        </Button>
                        <button
                          type="button"
                          class="shrink-0 text-text-weak"
                          onClick={() => props.onExpand(open() ? undefined : plugin.id)}
                          aria-label={open() ? "collapse" : "expand"}
                        >
                          <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" />
                        </button>
                      </div>
                      <Show when={open()}>
                        <div class="border-t border-border-weak-base bg-surface-base px-3 py-3">
                          <Show when={plugin.source}>
                            <div class="mb-2 truncate text-11-regular text-text-weak">
                              {language.t("config.claws.dsh.plugins.source", { source: plugin.source! })}
                            </div>
                          </Show>
                          <Show when={plugin.name}>
                            <div class="mb-2 break-all text-11-regular text-text-weak">{plugin.name}</div>
                          </Show>
                          <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                            {language.t("config.claws.dsh.plugins.config")}
                          </div>
                          <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-12-regular text-text-base">
                            {plugin.configPreview || language.t("config.claws.dsh.plugins.noConfig")}
                          </pre>
                          <Show when={conditional()}>
                            <div class="mt-2 text-11-regular text-text-weak">
                              {language.t("config.claws.dsh.plugins.conditionalHint")}
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={!props.inventory && !props.loading}>
        <div class="mt-4 text-12-regular text-text-weak">{language.t("config.claws.dsh.plugins.hint")}</div>
      </Show>
    </div>
  )
}

function CliAgentEditor(props: {
  item?: ClawItem
  descriptor: CliAgentDescriptor
  info?: CliAgentInfo
  infoLoading?: boolean
  form: ReturnType<typeof cliAgentCfg>
  dirty: boolean
  busy: boolean
  canTest: boolean
  plugins?: DshPluginInventory
  pluginsLoading?: boolean
  pluginsTogglingId?: string
  pluginsQuery?: string
  pluginsShowDisabled?: boolean
  pluginsExpandedId?: string
  onChange: (
    key: "enabled" | "binaryPath" | "configHome" | "provider" | "model" | "baseURL" | "apiKey" | "clearApiKey",
    value: string | boolean,
  ) => void
  onSave: () => void
  onTest: () => void
  onRefresh: () => void
  onToggleSecret?: () => void
  onCopyApiKey?: () => void
  apiKeyCopied?: boolean
  onLoadPlugins?: () => void
  onPluginsQuery?: (value: string) => void
  onPluginsShowDisabled?: (value: boolean) => void
  onPluginsExpand?: (id?: string) => void
  onSetPluginEnabled?: (id: string, enabled: boolean) => void
}) {
  const language = useLanguage()
  const settings = useSettings()
  const isDsh = () => props.descriptor.id === "dsh"
  const apiKeyStatus = () => {
    if (props.form.clearApiKey) return language.t("config.claws.dsh.apiKeyStatus.willClear")
    if (props.form.apiKey.trim()) return language.t("config.claws.dsh.apiKeyStatus.willWrite")
    if (props.form.hasFileApiKey && props.form.apiKeyEnvSet)
      return language.t("config.claws.dsh.apiKeyStatus.fileAndEnv")
    if (props.form.hasFileApiKey) return language.t("config.claws.dsh.apiKeyStatus.file")
    if (props.form.apiKeyEnvSet) return language.t("config.claws.dsh.apiKeyStatus.env")
    return language.t("config.claws.dsh.apiKeyStatus.none")
  }

  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show
        when={props.item}
        fallback={<div class="px-4 py-10 text-13-regular text-text-weak">{language.t("config.claws.empty")}</div>}
      >
        <ClawHeader
          item={props.item}
          enabled={props.form.enabled}
          busy={props.busy}
          saving={props.form.saving}
          testing={props.form.testing}
          onEnabled={(value) => props.onChange("enabled", value)}
        />

        <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          <div class="flex w-full flex-col gap-6">
            <Show when={props.infoLoading || props.info}>
              <CliAgentInfoCard descriptor={props.descriptor} info={props.info} loading={props.infoLoading} />
            </Show>

            <div class="grid gap-4 lg:grid-cols-2">
              <TextField
                type="text"
                label={language.t("config.claws.cliAgent.binary", { label: props.descriptor.label })}
                description={language.t("config.claws.cliAgent.binaryDescription", {
                  command: props.descriptor.command,
                })}
                placeholder={props.descriptor.command}
                value={props.form.binaryPath}
                disabled={props.busy || props.form.saving || props.form.testing}
                onChange={(value) => props.onChange("binaryPath", value)}
              />
              <TextField
                type="text"
                label={props.descriptor.configHomeLabel}
                description={language.t("config.claws.cliAgent.configHomeDescription")}
                placeholder={props.descriptor.configHomePlaceholder}
                value={props.form.configHome}
                disabled={props.busy || props.form.saving || props.form.testing}
                onChange={(value) => props.onChange("configHome", value)}
              />
            </div>

            <Show when={isDsh()}>
              <div class="rounded-2xl border border-border-weak-base bg-surface-base p-4">
                <div class="text-13-medium text-text-strong">{language.t("config.claws.dsh.title")}</div>
                <div class="mt-1 text-12-regular text-text-weak">{language.t("config.claws.dsh.description")}</div>
                <div class="mt-4 grid gap-4 lg:grid-cols-2">
                  <TextField
                    type="text"
                    label={language.t("config.claws.dsh.field.provider")}
                    description={language.t("config.claws.dsh.field.providerDescription")}
                    placeholder="deepseek-official"
                    value={props.form.provider}
                    disabled={props.busy || props.form.saving || props.form.testing}
                    onChange={(value) => props.onChange("provider", value)}
                  />
                  <TextField
                    type="text"
                    label={language.t("config.claws.dsh.field.model")}
                    description={language.t("config.claws.dsh.field.modelDescription")}
                    placeholder="deepseek-v4-flash"
                    value={props.form.model}
                    disabled={props.busy || props.form.saving || props.form.testing}
                    onChange={(value) => props.onChange("model", value)}
                  />
                </div>
                <div class="mt-4 grid gap-4">
                  <TextField
                    type="text"
                    label={language.t("config.claws.dsh.field.baseURL")}
                    description={
                      props.form.baseUrlEnvSet
                        ? language.t("config.claws.dsh.field.baseURLDescriptionEnv")
                        : language.t("config.claws.dsh.field.baseURLDescription")
                    }
                    placeholder={language.t("config.claws.dsh.field.baseURLPlaceholder")}
                    value={props.form.baseURL}
                    disabled={props.busy || props.form.saving || props.form.testing}
                    onChange={(value) => props.onChange("baseURL", value)}
                  />
                  <div class="space-y-2">
                    <div class="text-12-medium text-text-weak">{language.t("config.claws.dsh.field.apiKey")}</div>
                    <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2.5">
                      <div class="flex items-center gap-2">
                        <input
                          type={props.form.secret ? "password" : "text"}
                          placeholder={
                            props.form.hasFileApiKey || props.form.apiKeyEnvSet
                              ? language.t("config.claws.dsh.field.apiKeyPlaceholderKeep")
                              : language.t("config.claws.dsh.field.apiKeyPlaceholder")
                          }
                          value={props.form.apiKey}
                          disabled={props.busy || props.form.saving || props.form.testing || props.form.clearApiKey}
                          class="min-w-0 flex-1 bg-transparent text-13-regular text-text-base outline-none placeholder:text-text-weak disabled:opacity-50"
                          onInput={(event) => props.onChange("apiKey", event.currentTarget.value)}
                        />
                        <IconButton
                          type="button"
                          icon={props.form.secret ? "eye" : "close-small"}
                          variant="ghost"
                          disabled={props.busy || props.form.saving || props.form.testing || props.form.clearApiKey}
                          onClick={() => props.onToggleSecret?.()}
                          aria-label={
                            props.form.secret
                              ? language.t("config.claws.dsh.field.apiKeyShow")
                              : language.t("config.claws.dsh.field.apiKeyHide")
                          }
                        />
                        <IconButton
                          type="button"
                          icon={props.apiKeyCopied ? "check" : "copy"}
                          variant="ghost"
                          disabled={
                            props.busy ||
                            props.form.saving ||
                            props.form.testing ||
                            props.form.clearApiKey ||
                            !props.form.apiKey.trim()
                          }
                          onClick={() => props.onCopyApiKey?.()}
                          aria-label={language.t("config.claws.dsh.field.apiKeyCopy")}
                        />
                      </div>
                    </div>
                    <div class="text-12-regular text-text-weak">
                      {language.t("config.claws.dsh.field.apiKeyDescription", { status: apiKeyStatus() })}
                    </div>
                  </div>
                  <label class="inline-flex items-center gap-2 text-13-regular text-text-base">
                    <input
                      type="checkbox"
                      checked={props.form.clearApiKey}
                      disabled={props.busy || props.form.saving || props.form.testing || !props.form.hasFileApiKey}
                      onChange={(event) => props.onChange("clearApiKey", event.currentTarget.checked)}
                    />
                    {language.t("config.claws.dsh.field.clearApiKey")}
                  </label>
                </div>
              </div>

              <DshPluginInventoryCard
                inventory={props.plugins}
                loading={props.pluginsLoading}
                togglingId={props.pluginsTogglingId}
                query={props.pluginsQuery ?? ""}
                showDisabled={props.pluginsShowDisabled ?? true}
                expandedId={props.pluginsExpandedId}
                canLoad={!!props.onLoadPlugins}
                canToggle={!!props.onSetPluginEnabled}
                onQuery={(value) => props.onPluginsQuery?.(value)}
                onToggleDisabled={(value) => props.onPluginsShowDisabled?.(value)}
                onExpand={(id) => props.onPluginsExpand?.(id)}
                onLoad={() => props.onLoadPlugins?.()}
                onSetEnabled={(id, enabled) => props.onSetPluginEnabled?.(id, enabled)}
              />
            </Show>

            <div class="flex w-full flex-wrap items-center justify-end gap-2">
              <Button
                size="small"
                variant="secondary"
                icon="refresh"
                disabled={props.busy || props.form.saving || props.form.testing || props.infoLoading}
                onClick={props.onRefresh}
              >
                {language.t("config.claws.action.refreshInfo")}
              </Button>
              <ClawFormActions
                dirty={props.dirty}
                busy={props.busy}
                canTest={props.canTest}
                saving={props.form.saving}
                testing={props.form.testing}
                onSave={props.onSave}
                onTest={props.onTest}
              />
            </div>

            <Show when={props.form.testing || !!props.form.test}>
              <div class="rounded-2xl border border-border-weak-base bg-surface-base p-5">
                <div class="text-13-medium text-text-strong">{language.t("config.claws.debug.title")}</div>
                <div class="mt-1 text-12-regular text-text-weak">{language.t("config.claws.debug.description")}</div>
                <div class="mt-4 rounded-xl border border-border-weak-base bg-background-base px-4 py-3">
                  <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                    {language.t("config.claws.debug.status")}
                  </div>
                  <Show
                    when={props.form.testing}
                    fallback={
                      <div
                        class="mt-2 text-13-medium"
                        classList={{
                          "text-text-success": !!props.form.test?.ok,
                          "text-text-danger-base": !props.form.test?.ok,
                        }}
                      >
                        {props.form.test?.ok
                          ? language.t("config.claws.status.success")
                          : language.t("config.claws.status.failed")}
                      </div>
                    }
                  >
                    <div class="mt-2 inline-flex items-center gap-2 text-13-medium text-text-base">
                      <Spinner class="size-4" />
                      <span>{language.t("config.claws.status.testing")}</span>
                    </div>
                  </Show>
                </div>
                <div class="mt-4 rounded-xl border border-border-weak-base bg-background-base px-4 py-3">
                  <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                    {language.t("config.claws.debug.logs")}
                  </div>
                  <pre
                    class="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-12-regular text-text-weak"
                    style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
                  >
                    {props.form.testing
                      ? language.t("config.claws.status.testing")
                      : props.form.test?.logs.join("\n") || ""}
                  </pre>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

function HermesEditor(props: {
  item?: ClawItem
  info?: ExtraAgentInfo
  infoLoading?: boolean
  form: ReturnType<typeof hmCfg>
  dirty: boolean
  busy: boolean
  canTest: boolean
  onChange: (key: "enabled" | "pythonExecutable" | "hermesDir" | "hermesHome", value: string | boolean) => void
  onChooseDir: () => void
  onSave: () => void
  onTest: () => void
  onAbort?: () => void
}) {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show
        when={props.item}
        fallback={<div class="px-4 py-10 text-13-regular text-text-weak">{language.t("config.claws.empty")}</div>}
      >
        <ClawHeader
          item={props.item}
          enabled={props.form.enabled}
          busy={props.busy}
          saving={props.form.saving}
          testing={props.form.testing}
          onEnabled={(value) => props.onChange("enabled", value)}
        />

        <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          <div class="flex w-full flex-col gap-6">
            <Show when={props.infoLoading || props.info}>
              <ExtraAgentInfoCard info={props.info} loading={props.infoLoading} />
            </Show>

            <div class="grid gap-4 lg:grid-cols-2">
              <div class="min-w-0">
                <div class="mb-1.5 flex min-w-0 items-center justify-between gap-3">
                  <div class="min-w-0 truncate text-14-medium text-text-base">
                    {language.t("config.claws.field.hermesDir")}
                  </div>
                  <Button
                    size="small"
                    variant="secondary"
                    icon="folder-add-left"
                    onClick={props.onChooseDir}
                    disabled={props.busy || props.form.saving || props.form.testing}
                  >
                    {language.t("session.new.genericagent.cwd.choose")}
                  </Button>
                </div>
                <TextField
                  type="text"
                  hideLabel
                  label={language.t("config.claws.field.hermesDir")}
                  placeholder={language.t("config.claws.field.hermesDirPlaceholder")}
                  value={props.form.hermesDir}
                  validationState={props.form.err.hermesDir ? "invalid" : undefined}
                  disabled={props.busy || props.form.saving || props.form.testing}
                  onChange={(value) => props.onChange("hermesDir", value)}
                />
                <Show
                  when={props.form.err.hermesDir}
                  fallback={
                    <div class="mt-2 text-12-regular text-text-weak">
                      {language.t("config.claws.field.hermesDirDescription")}
                    </div>
                  }
                >
                  {(error) => <div class="mt-2 text-12-regular text-text-danger-base">{error()}</div>}
                </Show>
              </div>
              <TextField
                type="text"
                label={language.t("config.claws.field.pythonExecutable")}
                description={language.t("config.claws.field.pythonExecutableDescription")}
                placeholder={language.t("config.claws.field.pythonExecutablePlaceholder")}
                value={props.form.pythonExecutable}
                disabled={props.busy || props.form.saving || props.form.testing}
                onChange={(value) => props.onChange("pythonExecutable", value)}
              />
            </div>

            <TextField
              type="text"
              label={language.t("config.claws.field.hermesHome")}
              description={language.t("config.claws.field.hermesHomeDescription")}
              placeholder={language.t("config.claws.field.hermesHomePlaceholder")}
              value={props.form.hermesHome}
              disabled={props.busy || props.form.saving || props.form.testing}
              onChange={(value) => props.onChange("hermesHome", value)}
            />

            <ClawFormActions
              dirty={props.dirty}
              busy={props.busy}
              canTest={props.canTest}
              saving={props.form.saving}
              testing={props.form.testing}
              onSave={props.onSave}
              onTest={props.onTest}
              onAbort={props.onAbort}
            />

            <Show when={props.form.testing || !!props.form.test}>
              <div class="rounded-2xl border border-border-weak-base bg-surface-base p-5">
                <div class="text-13-medium text-text-strong">{language.t("config.claws.debug.title")}</div>
                <div class="mt-1 text-12-regular text-text-weak">{language.t("config.claws.debug.description")}</div>
                <div class="mt-4 rounded-xl border border-border-weak-base bg-background-base px-4 py-3">
                  <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                    {language.t("config.claws.debug.status")}
                  </div>
                  <Show
                    when={props.form.testing}
                    fallback={
                      <div
                        class="mt-2 text-13-medium"
                        classList={{
                          "text-text-success": !!props.form.test?.ok,
                          "text-text-danger-base": !props.form.test?.ok,
                        }}
                      >
                        {props.form.test?.ok
                          ? language.t("config.claws.status.success")
                          : language.t("config.claws.status.failed")}
                      </div>
                    }
                  >
                    <div class="mt-2 inline-flex items-center gap-2 text-13-medium text-text-base">
                      <Spinner class="size-4" />
                      <span>{language.t("config.claws.status.testing")}</span>
                    </div>
                  </Show>
                </div>
                <div class="mt-4 rounded-xl border border-border-weak-base bg-background-base px-4 py-3">
                  <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                    {language.t("config.claws.debug.logs")}
                  </div>
                  <pre
                    class="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-12-regular text-text-weak"
                    style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
                  >
                    {props.form.testing
                      ? language.t("config.claws.logs.testingHermes", {
                          dir: props.form.hermesDir.trim() || "-",
                          home: props.form.hermesHome.trim() || "~/.hermes",
                        })
                      : props.form.test?.logs.join("\n") || ""}
                  </pre>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

function CustomEditor(props: {
  item?: ProviderItem
  form: CustomState
  busy: boolean
  onToggle: (item: ProviderItem, enabled: boolean) => void
  onField: (key: "providerID" | "npm" | "name" | "baseURL" | "apiKey", value: string) => void
  onModel: (index: number, key: "id" | "name", value: string) => void
  onModelConfig: (modelIndex: number, configIndex: number, value: string) => void
  onToggleModelConfig: (index: number) => void
  onHeader: (index: number, key: "key" | "value", value: string) => void
  onAddModel: () => void
  onRemoveModel: (index: number) => void
  onAddHeader: () => void
  onRemoveHeader: (index: number) => void
  onSave: () => void
  onDelete: () => void
  onCreate: () => void
  onSecret: () => void
  onCopyApiKey?: () => void
  apiKeyCopied?: boolean
  onAddFetchedModel: (id: string, name: string) => void
}) {
  const language = useLanguage()
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const npmOptions = createMemo(() => customProviderNpmPackages(props.form.npm))
  const selectedNpm = createMemo(() => props.form.npm?.trim() || OPENAI_COMPATIBLE)

  createEffect(on(() => `${props.form.mode}:${props.form.providerID}`, () => setConfirmDelete(false), { defer: true }))

  const deleteProvider = () => {
    if (!confirmDelete()) {
      setConfirmDelete(true)
      return
    }
    setConfirmDelete(false)
    props.onDelete()
  }

  return (
    <div
      class="flex h-full min-h-0 flex-col"
      classList={{ "pointer-events-none select-none": props.busy || props.form.deleting }}
      aria-busy={props.busy || props.form.deleting}
      inert={props.busy || props.form.deleting ? true : undefined}
    >
      <Show
        when={props.item || props.form.mode === "create"}
        fallback={<div class="px-4 py-10 text-13-regular text-text-weak">{language.t("config.custom.select")}</div>}
      >
        <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border-weak-base px-4 py-4">
          <div>
            <div class="flex items-center gap-2">
              <div class="text-20-medium text-text-strong">
                {props.form.mode === "create" ? language.t("config.custom.new") : props.item?.id}
              </div>
              <span class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                {language.t("config.badge.custom")}
              </span>
              <Show when={props.item?.sdk || props.form.npm}>
                <span class="rounded-full bg-surface-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-weak">
                  {props.item?.sdk ?? props.form.npm}
                </span>
              </Show>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Show when={props.item}>
              <Toggle
                checked={!!props.item?.allowed}
                disabled={props.busy}
                onChange={(value) => props.item && props.onToggle(props.item, value)}
              >
                {language.t("config.provider.toggle.enabledInConfig")}
              </Toggle>
            </Show>
            <Show when={props.form.mode !== "create"}>
              <Button
                size="large"
                variant="ghost"
                class={confirmDelete() ? "text-text-danger-base" : undefined}
                onClick={deleteProvider}
                disabled={props.busy}
              >
                {confirmDelete() ? language.t("config.skills.delete.confirm") : language.t("config.action.delete")}
              </Button>
            </Show>
            <SaveButton
              size="large"
              label={
                props.form.saving
                  ? language.t("config.custom.savingProvider")
                  : language.t("config.custom.saveProvider")
              }
              onClick={props.onSave}
              disabled={props.busy || props.form.saving || props.form.deleting}
            />
          </div>
        </div>

        <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          <div class="mx-auto flex max-w-[920px] flex-col gap-6">
            <div class="grid gap-4 lg:grid-cols-2">
              <TextField
                autofocus={props.form.mode === "create"}
                label={language.t("config.custom.field.providerID")}
                placeholder="my-provider"
                value={props.form.providerID}
                readOnly={props.form.mode === "edit"}
                onChange={(value) => props.onField("providerID", value)}
                validationState={props.form.err.providerID ? "invalid" : undefined}
                error={props.form.err.providerID}
              />
              <div class="flex w-full flex-col items-start gap-2">
                <label class="text-12-medium text-text-weak">{language.t("config.custom.field.npm")}</label>
                <Select
                  options={npmOptions()}
                  current={npmOptions().find((option) => option === selectedNpm())}
                  onSelect={(value) => value && props.onField("npm", value)}
                  variant="secondary"
                  size="large"
                  valueClass="font-mono text-13-regular"
                  triggerStyle={{ width: "100%", "justify-content": "space-between", transform: "none" }}
                  triggerProps={{ "aria-label": language.t("config.custom.field.npm") }}
                >
                  {(option) => <span class="font-mono text-12-medium">{option}</span>}
                </Select>
              </div>
              <TextField
                label={language.t("config.custom.field.name")}
                placeholder={language.t("config.custom.field.namePlaceholder")}
                value={props.form.name}
                onChange={(value) => props.onField("name", value)}
                validationState={props.form.err.name ? "invalid" : undefined}
                error={props.form.err.name}
              />
              <TextField
                label={language.t("config.custom.field.baseURL")}
                placeholder="https://api.example.com/v1"
                value={props.form.baseURL}
                onChange={(value) => props.onField("baseURL", value)}
                validationState={props.form.err.baseURL ? "invalid" : undefined}
                error={props.form.err.baseURL}
              />
            </div>

            <div class="space-y-2">
              <div class="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                <span class="text-12-medium text-text-weak">{language.t("config.custom.field.apiKey")}</span>
                <span class="text-11-regular text-text-weak/70">
                  {language.t("config.custom.field.apiKeyDescription")}
                </span>
              </div>
              <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2.5">
                <div class="flex items-center gap-2">
                  <input
                    type={props.form.secret ? "password" : "text"}
                    placeholder="sk-... or {env:MY_PROVIDER_KEY}"
                    value={props.form.apiKey}
                    class="min-w-0 flex-1 bg-transparent text-13-regular text-text-base outline-none placeholder:text-text-weak"
                    onInput={(event) => props.onField("apiKey", event.currentTarget.value)}
                  />
                  <IconButton
                    type="button"
                    icon={props.form.secret ? "eye" : "close-small"}
                    variant="ghost"
                    onClick={props.onSecret}
                    aria-label={props.form.secret ? "Show API key" : "Hide API key"}
                  />
                  <IconButton
                    type="button"
                    icon={props.apiKeyCopied ? "check" : "copy"}
                    variant="ghost"
                    disabled={!props.form.apiKey.trim()}
                    onClick={props.onCopyApiKey}
                    aria-label={language.t("config.custom.field.apiKeyCopy")}
                  />
                </div>
              </div>
            </div>

            <div class="rounded-xl border border-border-weak-base bg-background-base p-4">
              <div class="mb-3">
                <FetchProviderModels
                  title={language.t("config.custom.models.title")}
                  baseURL={props.form.baseURL}
                  apiKey={props.form.apiKey}
                  headers={props.form.headers}
                  existingModelIDs={new Set(props.form.models.map((m) => m.id.trim()).filter(Boolean))}
                  onAdd={props.onAddFetchedModel}
                />
              </div>
              <div class="config-custom-model-list mb-3 flex flex-col gap-3">
                {/*
                  5-col grid shared with each row so header labels line up with
                  the id / title fields (test button has its own fixed column).
                  Icon slots are 24px to match default IconButton size.
                */}
                <div class="hidden gap-2 p-2 md:grid md:grid-cols-[24px_minmax(0,1fr)_5.5rem_minmax(0,1fr)_24px]">
                  <div aria-hidden="true" />
                  <div class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 pl-3">
                    <span class="text-12-medium text-text-weak">{language.t("config.custom.models.id")}</span>
                    <span class="text-11-regular text-text-weak/70">{language.t("config.custom.models.id.hint")}</span>
                  </div>
                  <div aria-hidden="true" />
                  <div class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 pl-3">
                    <span class="text-12-medium text-text-weak">{language.t("config.custom.models.name")}</span>
                    <span class="text-11-regular text-text-weak/70">
                      {language.t("config.custom.models.name.hint")}
                    </span>
                  </div>
                  <div aria-hidden="true" />
                </div>
                <For each={props.form.models}>
                  {(item, idx) => (
                    <div class="rounded-xl border border-border-weak-base bg-surface-base/60 p-2" data-row={item.row}>
                      <div class="config-custom-model-summary grid gap-2 md:grid-cols-[24px_minmax(0,1fr)_5.5rem_minmax(0,1fr)_24px]">
                        <IconButton
                          type="button"
                          icon={item.expanded ? "chevron-down" : "chevron-right"}
                          variant="ghost"
                          class="mt-1.5"
                          onClick={() => props.onToggleModelConfig(idx())}
                          aria-label={
                            item.expanded
                              ? language.t("provider.custom.models.config.collapse")
                              : language.t("provider.custom.models.config.expand")
                          }
                        />
                        <TextField
                          label={language.t("config.custom.models.id")}
                          hideLabel
                          placeholder="模型 ID (如: gpt-4o, claude-3-opus)"
                          value={item.id}
                          onChange={(value) => props.onModel(idx(), "id", value)}
                          validationState={item.err.id ? "invalid" : undefined}
                          error={item.err.id}
                        />
                        <TestProviderModelButton
                          class="flex h-8 w-full items-center justify-center"
                          baseURL={props.form.baseURL}
                          apiKey={props.form.apiKey}
                          modelId={item.id}
                          npm={props.form.npm}
                          headers={props.form.headers}
                        />
                        <TextField
                          label={language.t("config.custom.models.name")}
                          hideLabel
                          placeholder="显示名称 (如: GPT-4o, Claude 3 Opus)"
                          value={item.name}
                          onChange={(value) => props.onModel(idx(), "name", value)}
                          validationState={item.err.name ? "invalid" : undefined}
                          error={item.err.name}
                        />
                        <IconButton
                          type="button"
                          icon="trash"
                          variant="ghost"
                          class="mt-1.5"
                          onClick={() => props.onRemoveModel(idx())}
                          disabled={props.form.models.length <= 1}
                          aria-label={language.t("config.custom.models.remove")}
                        />
                      </div>
                      <Show when={item.expanded}>
                        <div class="mt-2 grid grid-cols-[minmax(150px,0.8fr)_minmax(0,1.2fr)] items-start gap-2 border-t border-border-weak-base pt-2">
                          <For each={item.config}>
                            {(config: ModelConfigRow, configIndex) => (
                              <>
                                <div class="min-w-0 break-all rounded-lg bg-background-base px-2.5 py-2 font-mono text-[11px] leading-5 text-text-weak">
                                  {config.key}
                                </div>
                                <Show
                                  when={config.kind === "json"}
                                  fallback={
                                    <TextField
                                      label={config.key}
                                      hideLabel
                                      placeholder={modelConfigPlaceholder(config, language.t)}
                                      value={config.value}
                                      onChange={(value) => props.onModelConfig(idx(), configIndex(), value)}
                                      validationState={item.err.config?.[config.key] ? "invalid" : undefined}
                                      error={item.err.config?.[config.key]}
                                    />
                                  }
                                >
                                  <JsonCodeField
                                    label={config.key}
                                    hideLabel
                                    placeholder={modelConfigPlaceholder(config, language.t)}
                                    value={config.value}
                                    onChange={(value) => props.onModelConfig(idx(), configIndex(), value)}
                                    validationState={item.err.config?.[config.key] ? "invalid" : undefined}
                                    error={item.err.config?.[config.key]}
                                  />
                                </Show>
                              </>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
              <div>
                <Button size="large" variant="ghost" icon="plus-small" onClick={props.onAddModel}>
                  {language.t("config.custom.models.add")}
                </Button>
              </div>
            </div>

            <div class="rounded-xl border border-border-weak-base bg-background-base p-4">
              <div class="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div class="text-13-medium text-text-strong">{language.t("config.custom.headers.title")}</div>
                  <div class="text-12-regular text-text-weak">{language.t("config.custom.headers.description")}</div>
                </div>
                <Button size="large" variant="ghost" icon="plus-small" onClick={props.onAddHeader}>
                  {language.t("config.custom.headers.add")}
                </Button>
              </div>
              <div class="flex flex-col gap-3">
                <For each={props.form.headers}>
                  {(item, idx) => (
                    <div class="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" data-row={item.row}>
                      <TextField
                        label={language.t("config.custom.headers.key")}
                        hideLabel
                        placeholder="Authorization"
                        value={item.key}
                        onChange={(value) => props.onHeader(idx(), "key", value)}
                        validationState={item.err.key ? "invalid" : undefined}
                        error={item.err.key}
                      />
                      <TextField
                        label={language.t("config.custom.headers.value")}
                        hideLabel
                        placeholder="Bearer ..."
                        value={item.value}
                        onChange={(value) => props.onHeader(idx(), "value", value)}
                        validationState={item.err.value ? "invalid" : undefined}
                        error={item.err.value}
                      />
                      <IconButton
                        type="button"
                        icon="trash"
                        variant="ghost"
                        class="mt-1.5"
                        onClick={() => props.onRemoveHeader(idx())}
                        disabled={props.form.headers.length <= 1}
                        aria-label={language.t("config.custom.headers.remove")}
                      />
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

function configPerfSinceClick() {
  const clickAt = (window as Window & { __configNavClickAt?: number }).__configNavClickAt
  if (typeof clickAt !== "number") return "n/a"
  return `${(performance.now() - clickAt).toFixed(1)}ms`
}

export default function ConfigPage() {
  const pageConstructAt = performance.now()
  console.info(`[config-perf] page construct start sinceClick=${configPerfSinceClick()}`)
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const sync = useSync()
  const server = useServer()
  const navigate = useNavigate()
  const params = useParams()
  const layout = useLayout()
  const [query] = useSearchParams<{ section?: string; pick?: string }>()
  const initialSection = (() => {
    const section = query.section
    if (typeof section !== "string" || !isKnownSection(section)) return "providers" as Section
    if (section === "claws" && platform.platform !== "desktop") return "providers" as Section
    return section as Section
  })()
  const initialPick = initialSection && typeof query.pick === "string" ? query.pick : ""

  onMount(() => {
    console.info(
      `[config-perf] page mount sinceClick=${configPerfSinceClick()} constructMs=${(performance.now() - pageConstructAt).toFixed(1)} providerAll=${String(globalSync.data.provider.all.length)}`,
    )
    if (platform.platform !== "desktop") return
    if (!layout.sidebar.opened()) return
    layout.sidebar.close()
  })
  const cache = new Map<string, string>()
  const pending = new Map<string, Promise<string>>()
  const trees = new Map<string, TreeNode[]>()
  const treePending = new Map<string, Promise<TreeNode[]>>()
  let openRun = 0
  let jumpRun = 0
  let skillsList: HTMLDivElement | undefined
  const [state, setState] = createStore({
    section: initialSection,
    pick: initialPick,
    focusPane: "left" as "left" | "middle" | "right",
    focusVisible: false,
    doc: "",
    text: "",
    saved: "",
    query: "",
    agentQuery: "",
    commandQuery: "",
    pluginQuery: "",
    providerBusy: "",
    providerOffCollapsed: true,
    customID: "",
    customApiDirty: false,
    custom: providerCfg(undefined),
    claw: clawCfg(),
    ga: gaCfg(),
    hm: hmCfg(),
    cliAgents: {} as Partial<Record<CliAgentID, ReturnType<typeof cliAgentCfg>>>,
    skillTitle: "",
    skillErr: "",
    skillPath: "",
    skillNote: "",
    skillWarn: "",
    skillCreateRoot: "",
    skillCreateProjectRoot: "",
    skillCreateProjectLabel: "",
    skillSaving: false,
    skillPanel: "editor" as "editor" | "market",
    skillMarketRepo: SKILL_MARKET_REPOS[0]?.id ?? "",
    skillQuery: "",
    skillMarketCustomInput: "",
    skillMarketCustomError: "",
    skillMarketCustomRepos: loadStoredSkillMarketRepos(),
    skillMarketInstalling: "",
    treeClosed: {} as Record<string, boolean>,
    busy: false,
    workspaceRev: 0,
    skillRev: 0,
    pluginRev: 0,
    agentRev: 0,
    clawRev: 0,
    gaRev: 0,
    hmRev: 0,
    commandRev: 0,
    cmdTitle: "",
    cmdPath: "",
    cmdCreateDir: "",
    cmdCreateProjectRoot: "",
    cmdCreateProjectLabel: "",
    cmdSaving: false,
    cmdErr: "",
    mcpForm: { type: "local" as "local" | "remote", command: "", url: "", environment: "", headers: "" },
    mcpNewName: "",
    mcpTargetDirectory: "",
    mcpSaving: false,
    mcpDirty: false,
    mcpBusy: "",
    mcpGlobalDeleting: {} as Record<string, boolean>,
    copied: "" as "dsh-api-key" | "custom-api-key" | "config-path" | "",
  })
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  const markCopied = (value: typeof state.copied) => {
    setState("copied", value)
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => setState("copied", ""), 1_200)
  }

  onCleanup(() => {
    if (copiedTimer) clearTimeout(copiedTimer)
  })

  const refreshAfterBackendReload = () => {
    console.info("[config] backend reload refresh started")
    bump("workspaceRev", "skillRev", "pluginRev", "agentRev", "clawRev", "gaRev", "hmRev")
    console.info("[config] backend reload refresh completed")
  }

  const onConfigPageRefresh = () => {
    refreshAfterBackendReload()
  }

  window.addEventListener(CONFIG_PAGE_REFRESH_EVENT, onConfigPageRefresh)
  onCleanup(() => window.removeEventListener(CONFIG_PAGE_REFRESH_EVENT, onConfigPageRefresh))

  function bump(
    ...list: Array<
      "workspaceRev" | "skillRev" | "pluginRev" | "agentRev" | "clawRev" | "gaRev" | "hmRev" | "commandRev"
    >
  ) {
    list.forEach((key) => setState(key, (value) => value + 1))
  }

  const mcpGlobal = createMemo(() => {
    const cfg = globalSync.data.config.mcp ?? {}
    const dirMcp = sync.data.mcp ?? {}
    return Object.keys(cfg)
      .map((name_) => {
        const entry = cfg[name_] as Record<string, unknown> | undefined
        const status = dirMcp[name_]?.status ?? "disabled"
        const type = entry ? ((entry.type as string) ?? "unknown") : "unknown"
        const detail = entry
          ? type === "local"
            ? formatArgv((entry.command as string[]) ?? [])
            : type === "remote"
              ? ((entry.url as string) ?? "")
              : ""
          : ""
        return { id: mcpSelectionID({ scope: "global", directory: "", name: name_ }), name: name_, type, detail, status }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const [projectMcpRecords, { refetch: refetchProjectMcpRecords }] = createResource(
    () => sync.data.path?.directory,
    async (directory) => (directory ? loadConfigRecords(directory, "project") : []),
  )

  const mcpProject = createMemo(() => {
    const directory = sync.data.path?.directory ?? ""
    const declared = declaredMcpEntries(projectMcpRecords.latest ?? [])
    const mergedCfg = sync.data.config?.mcp ?? {}
    const dirMcp = sync.data.mcp ?? {}
    const items = Object.keys(declared)
      .filter((name_) => !state.mcpGlobalDeleting[name_])
      .map((name_) => {
        const entry = mergedCfg[name_] as Record<string, unknown> | undefined
        const status = dirMcp[name_]?.status ?? "disabled"
        const type = entry ? ((entry.type as string) ?? "unknown") : "unknown"
        const detail = entry
          ? type === "local"
            ? formatArgv((entry.command as string[]) ?? [])
            : type === "remote"
              ? ((entry.url as string) ?? "")
              : ""
          : ""
        return {
          id: mcpSelectionID({ scope: "project", directory, name: name_ }),
          name: name_,
          type,
          detail,
          status,
          draft: false,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    if (state.pick === MCP_NEW && state.mcpTargetDirectory === sync.data.path?.directory) {
      const name = state.mcpNewName.trim() || t("config.mcp.add")
      const detail = state.mcpForm.type === "local" ? state.mcpForm.command.trim() : state.mcpForm.url.trim()
      return [{ id: MCP_NEW, name, type: state.mcpForm.type, detail, status: "disabled", draft: true }, ...items]
    }
    return items
  })

  const mcpProjectName = createMemo(() => sync.data.project || name(sync.data.path?.directory ?? ""))
  const mcpProjectOpen = () => !state.treeClosed["mcp-project"]
  const toggleMcpProject = () => setState("treeClosed", "mcp-project", (v) => !v)
  const channelMiddleItems = useChannelMiddleItems(() => state.pick)
  const selectedChannelPlatform = createMemo(() => parseChannelPick(state.pick))

  const selectedMcpName = createMemo(() => {
    if (state.pick === MCP_NEW) return undefined
    return parseMcpSelectionID(state.pick)?.name
  })

  const selectedMcpSelection = createMemo(() => parseMcpSelectionID(state.pick))

  const selectedMcpStatus = createMemo(() => {
    const n = selectedMcpName()
    if (!n) return undefined
    return sync.data.mcp?.[n]?.status ?? "disabled"
  })

  const selectedMcpConfig = createMemo(() => {
    const n = selectedMcpName()
    if (!n) return undefined
    const selected = selectedMcpSelection()
    if (selected?.scope === "global") return globalSync.data.config.mcp?.[n] as Record<string, unknown> | undefined
    return sync.data.config?.mcp?.[n] as Record<string, unknown> | undefined
  })

  const selectedMcpDirectory = createMemo(() => {
    const selected = selectedMcpSelection()
    return selected?.scope === "project" ? selected.directory : ""
  })

  createEffect(
    on(
      () => selectedMcpConfig(),
      (entry) => {
        if (!entry) return
        const entryType = ((entry.type as string) ?? "local") as "local" | "remote"
        setState("mcpForm", {
          type: entryType,
          command: entryType === "local" ? formatArgv((entry.command as string[]) ?? []) : "",
          url: entryType === "remote" ? ((entry.url as string) ?? "") : "",
          environment:
            entryType === "local" && entry.environment
              ? Object.entries(entry.environment as Record<string, string>)
                  .map(([k, v]) => `${k}=${v}`)
                  .join("\n")
              : "",
          headers:
            entryType === "remote" && entry.headers
              ? Object.entries(entry.headers as Record<string, string>)
                  .map(([k, v]) => `${k}=${v}`)
                  .join("\n")
              : "",
        })
        setState("mcpDirty", false)
      },
    ),
  )

  function setMcpField(field: "type" | "command" | "url" | "environment" | "headers", value: string) {
    setState("mcpForm", field, value)
    setState("mcpDirty", true)
  }

  function parseKeyValue(text: string): Record<string, string> | undefined {
    if (!text.trim()) return undefined
    const result: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const eq = trimmed.indexOf("=")
      if (eq <= 0) continue
      result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
    return Object.keys(result).length > 0 ? result : undefined
  }

  async function loadConfigRecords(directory: string | null, scope: "global" | "project") {
    if (!platform.listConfigFiles || !platform.readLocalFile || !platform.writeLocalFile)
      throw new Error(t("config.error.globalConfigUnavailable"))
    const files = (await platform.listConfigFiles(directory)).filter(
      (file) => file.scope === scope && file.kind === "config",
    )
    return Promise.all(
      files.map(async (file) => ({
        file,
        text: file.exists ? ((await platform.readLocalFile!(file.path)) ?? "{}") : "{}",
      })),
    )
  }

  async function writeConfigRecord(path: string, text: string) {
    if (!platform.writeLocalFile) throw new Error(t("config.error.globalConfigUnavailable"))
    await platform.writeLocalFile(path, text)
  }

  async function saveMcpServer() {
    const isNew = state.pick === MCP_NEW
    const n = isNew ? state.mcpNewName.trim() : selectedMcpName()
    if (!n || state.mcpSaving) return
    const targetDirectory = isNew ? state.mcpTargetDirectory : selectedMcpDirectory()
    const targetStore = targetDirectory ? globalSync.child(targetDirectory, { bootstrap: false }) : undefined
    const currentConfig = targetDirectory ? targetStore?.[0].config : globalSync.data.config
    setState("mcpSaving", true)
    try {
      const form = state.mcpForm
      let config: Record<string, unknown>
      if (form.type === "local") {
        const parts = parseArgv(form.command)
        if (parts.length === 0) return
        config = { type: "local", command: parts }
        const env = parseKeyValue(form.environment)
        if (env) config.environment = env
      } else {
        if (!form.url.trim()) return
        config = { type: "remote", url: form.url.trim() }
        const hdrs = parseKeyValue(form.headers)
        if (hdrs) config.headers = hdrs
      }
      const current = currentConfig?.mcp ?? {}
      if (targetDirectory && targetStore) {
        const client = globalSDK.forDomain(mainDomain).createClient({ directory: targetDirectory, throwOnError: true })
        const records = await loadConfigRecords(targetDirectory, "project")
        if (isNew && declaredMcpEntry(records, n)) throw new Error(`Project MCP server ${n} already exists.`)
        const target = selectProjectMcpConfig(records, n, isNew)
        if (!target) throw new Error(`No project config declares MCP server ${n}.`)
        const text = updateProjectMcpText(
          target.text,
          n,
          config as never,
          isNew ? undefined : current[n],
          isNew ? undefined : declaredMcpEntry(records, n),
        )
        console.info(`[config] project MCP save target=${target.file.path} name=${n} fields=mcp`)
        await writeConfigRecord(target.file.path, text)
        await globalSDK.forDomain(mainDomain).client.instance.dispose({ directory: targetDirectory }).catch(() => undefined)
        await client.mcp.add({ name: n, config: config as never })
        const result = await client.config.get()
        if (result.data) targetStore[1]("config", result.data)
        await refetchProjectMcpRecords()
      } else {
        const records = await loadConfigRecords(null, "global")
        if (isNew && declaredMcpEntry(records, n)) throw new Error(`Global MCP server ${n} already exists.`)
        const target = selectProjectMcpConfig(records, n, isNew)
        if (!target) throw new Error(`No global config declares MCP server ${n}.`)
        const text = updateProjectMcpText(
          target.text,
          n,
          config as never,
          isNew ? undefined : current[n],
          isNew ? undefined : declaredMcpEntry(records, n),
        )
        console.info(`[config] global MCP save target=${target.file.path} name=${n} fields=mcp`)
        await writeConfigRecord(target.file.path, text)
        await globalSync.refreshConfig(mainDomain)
        const directory = sync.data.path?.directory
        if (directory) {
          const domainClient = globalSDK.forDomain(mainDomain)
          await domainClient.client.instance.dispose({ directory }).catch(() => undefined)
          const client = domainClient.createClient({ directory, throwOnError: true })
          const result = await client.config.get()
          if (result.data) globalSync.child(directory, { bootstrap: false })[1]("config", result.data)
        } else {
          await globalSDK.forDomain(mainDomain).client.mcp.add({ name: n, config: config as never })
        }
      }
      setState("mcpDirty", false)
      if (isNew) {
        batch(() => {
          setState(
            "pick",
            mcpSelectionID({ scope: targetDirectory ? "project" : "global", directory: targetDirectory, name: n }),
          )
          setState("mcpNewName", "")
          setState("mcpTargetDirectory", "")
        })
      }
    } finally {
      setState("mcpSaving", false)
    }
  }

  async function deleteMcpServer() {
    const n = selectedMcpName()
    if (!n) return
    const targetDirectory = selectedMcpDirectory()
    const targetStore = targetDirectory ? globalSync.child(targetDirectory, { bootstrap: false }) : undefined
    if (targetDirectory && targetStore) {
      const client = globalSDK.forDomain(mainDomain).createClient({ directory: targetDirectory, throwOnError: true })
      const records = await loadConfigRecords(targetDirectory, "project")
      const declarations = mcpDeclarationRecords(records, n)
      if (declarations.length === 0) throw new Error(`No project config declares MCP server ${n}.`)
      for (const target of declarations) {
        const text = updateProjectMcpText(target.text, n, undefined)
        console.info(`[config] project MCP delete target=${target.file.path} name=${n} fields=mcp`)
        await writeConfigRecord(target.file.path, text)
      }
      await globalSDK.forDomain(mainDomain).client.instance.dispose({ directory: targetDirectory }).catch(() => undefined)
      const result = await client.config.get()
      if (result.data) targetStore[1]("config", result.data)
      await refetchProjectMcpRecords()
    } else {
      setState("mcpGlobalDeleting", n, true)
      try {
        const records = await loadConfigRecords(null, "global")
        const declarations = mcpDeclarationRecords(records, n)
        if (declarations.length === 0) throw new Error(`No global config declares MCP server ${n}.`)
        for (const target of declarations) {
          const text = updateProjectMcpText(target.text, n, undefined)
          console.info(`[config] global MCP delete target=${target.file.path} name=${n} fields=mcp`)
          await writeConfigRecord(target.file.path, text)
        }
        await globalSync.refreshConfig(mainDomain)
        const directory = sync.data.path?.directory
        if (directory) {
          await globalSDK.forDomain(mainDomain).client.instance.dispose({ directory }).catch(() => undefined)
          const client = globalSDK.forDomain(mainDomain).createClient({ directory, throwOnError: true })
          const result = await client.config.get()
          if (result.data) globalSync.child(directory, { bootstrap: false })[1]("config", result.data)
        }
      } finally {
        setState("mcpGlobalDeleting", n, false)
      }
    }
    setState("pick", "")
  }

  function toggleMcp(name: string, enabled: boolean) {
    if (state.mcpBusy === name) return
    setState("mcpBusy", name)
    const directory = sync.data.path?.directory
    const client = directory
      ? globalSDK.forDomain(mainDomain).createClient({ directory, throwOnError: true })
      : globalSDK.forDomain(mainDomain).client
    const action = enabled ? client.mcp.connect({ name }) : client.mcp.disconnect({ name })
    void action
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        setState("mcpBusy", "")
      })
  }

  function createMcp(targetDirectory = "") {
    setState("pick", MCP_NEW)
    setState("mcpNewName", "")
    setState("mcpTargetDirectory", targetDirectory)
    setState("mcpForm", { type: "local" as const, command: "", url: "", environment: "", headers: "" })
    setState("mcpDirty", true)
    setState("mcpSaving", false)
  }

  function cancelMcpCreate() {
    batch(() => {
      setState("pick", "")
      setState("mcpNewName", "")
      setState("mcpTargetDirectory", "")
      setState("mcpForm", { type: "local" as const, command: "", url: "", environment: "", headers: "" })
      setState("mcpDirty", false)
      setState("mcpSaving", false)
    })
  }

  const [workspace] = createResource(
    () => state.workspaceRev,
    async () => {
      // Shared by agents-md / skills / plugins / commands roots — keep eager.
      console.info("[config-perf] fetch configWorkspace start")
      const started = performance.now()
      if (!platform.getConfigWorkspace) return undefined
      const result = await platform.getConfigWorkspace()
      console.info(`[config-perf] fetch configWorkspace done ms=${(performance.now() - started).toFixed(1)}`)
      return result
    },
  )

  const [rawSkills] = createResource(
    () => (state.section === "skills" ? state.skillRev : false),
    async () => {
      console.info("[config-perf] fetch app.skills start")
      const started = performance.now()
      const resp = await globalSDK.client.app.skills({}, { throwOnError: true })
      console.info(`[config-perf] fetch app.skills done ms=${(performance.now() - started).toFixed(1)}`)
      return resp.data ?? []
    },
  )

  const [loaded] = createResource(
    () => (state.section === "agents" ? state.agentRev : false),
    async () => {
      console.info("[config-perf] fetch app.agents start")
      const started = performance.now()
      const resp = await globalSDK.client.app.agents({}, { throwOnError: true })
      console.info(`[config-perf] fetch app.agents done ms=${(performance.now() - started).toFixed(1)}`)
      return resp.data ?? []
    },
  )

  const [configFileAgents, setConfigFileAgents] = createSignal<Config["agent"]>()
  let configFileAgentsRun = 0
  createEffect(
    on(
      () => [state.section, state.agentRev] as const,
      ([section]) => {
        if (section !== "agents") return
        const run = ++configFileAgentsRun
        void loadConfigFileAgents(platform)
          .then((agents) => {
            if (run === configFileAgentsRun) setConfigFileAgents(agents)
          })
          .catch(() => {
            if (run === configFileAgentsRun) setConfigFileAgents(undefined)
          })
      },
      { defer: false },
    ),
  )

  const [openclawConfig, setOpenclawConfigState] = createSignal<OpenclawConfig>()
  const [openclawLoading, setOpenclawLoading] = createSignal(false)
  const [genericagentConfig, setGenericagentConfigState] = createSignal<GenericagentConfig>()
  const [genericagentLoading, setGenericagentLoading] = createSignal(false)
  const [hermesConfig, setHermesConfigState] = createSignal<HermesConfig>()
  const [hermesLoading, setHermesLoading] = createSignal(false)
  const [cliAgentDescriptors, setCliAgentDescriptors] = createSignal<CliAgentDescriptor[]>([])
  const [cliAgentConfigs, setCliAgentConfigs] = createStore<Partial<Record<CliAgentID, CliAgentConfig>>>({})
  const [cliAgentInfo, setCliAgentInfo] = createStore<Partial<Record<CliAgentID, CliAgentInfo>>>({})
  const [cliAgentLoading, setCliAgentLoading] = createStore<
    Partial<Record<CliAgentID, { config: boolean; info: boolean }>>
  >({})
  const [dshPlugins, setDshPlugins] = createStore({
    inventory: undefined as DshPluginInventory | undefined,
    loading: false,
    togglingId: undefined as string | undefined,
    query: "",
    showDisabled: true,
    expandedId: undefined as string | undefined,
  })
  let openclawConfigRun = 0
  let genericagentConfigRun = 0
  let hermesConfigRun = 0
  let cliAgentsRun = 0
  let dshPluginsRun = 0
  const cliAgentInfoRuns: Partial<Record<CliAgentID, number>> = {}

  createEffect(
    on(
      () => [state.section, state.pick, state.clawRev] as const,
      ([section, pick, rev]) => {
        if (section !== "claws" || pick !== "claw:openclaw" || !platform.getOpenclawConfig) {
          openclawConfigRun++
          setOpenclawLoading(false)
          return
        }
        const run = ++openclawConfigRun
        setOpenclawLoading(true)
        void platform
          .getOpenclawConfig()
          .then((result) => {
            if (run !== openclawConfigRun) return
            setOpenclawConfigState(result)
          })
          .finally(() => {
            if (run !== openclawConfigRun) return
            setOpenclawLoading(false)
          })
      },
    ),
  )

  createEffect(
    on(
      () => [state.section, state.pick, state.gaRev] as const,
      ([section, pick, rev]) => {
        if (section !== "claws" || pick !== "claw:genericagent" || !platform.getGenericagentConfig) {
          genericagentConfigRun++
          setGenericagentLoading(false)
          return
        }
        const run = ++genericagentConfigRun
        setGenericagentLoading(true)
        void platform
          .getGenericagentConfig()
          .then((result) => {
            if (run !== genericagentConfigRun) return
            setGenericagentConfigState(result)
          })
          .finally(() => {
            if (run !== genericagentConfigRun) return
            setGenericagentLoading(false)
          })
      },
    ),
  )

  createEffect(
    on(
      () => [state.section, state.pick, state.hmRev] as const,
      ([section, pick, rev]) => {
        if (section !== "claws" || pick !== "claw:hermes" || !platform.getHermesConfig) {
          hermesConfigRun++
          setHermesLoading(false)
          return
        }
        const run = ++hermesConfigRun
        setHermesLoading(true)
        void platform
          .getHermesConfig()
          .then((result) => {
            if (run !== hermesConfigRun) return
            setHermesConfigState(result)
          })
          .finally(() => {
            if (run !== hermesConfigRun) return
            setHermesLoading(false)
          })
      },
    ),
  )

  createEffect(
    on(
      () => state.section,
      (section) => {
        const cliAgents = platform.cliAgents
        if (section !== "claws" || !cliAgents) {
          cliAgentsRun++
          setCliAgentDescriptors([])
          for (const agent of cliAgentDescriptors()) setCliAgentLoading(agent.id, { config: false, info: false })
          return
        }

        const run = ++cliAgentsRun
        void cliAgents
          .list()
          .then(async (descriptors) => {
            if (run !== cliAgentsRun) return
            setCliAgentDescriptors(descriptors)
            for (const descriptor of descriptors) {
              if (!state.cliAgents[descriptor.id]) setState("cliAgents", descriptor.id, cliAgentCfg())
              setCliAgentLoading(descriptor.id, { config: false, info: false })
            }
            await Promise.allSettled(
              descriptors.map(async ({ id }) => {
                setCliAgentLoading(id, { config: true, info: true })
                const config = await cliAgents.get(id)
                if (run !== cliAgentsRun) return
                setCliAgentConfigs(id, config)
                setState("cliAgents", id, cliAgentCfg(config))
                setCliAgentLoading(id, "config", false)

                const infoRun = (cliAgentInfoRuns[id] ?? 0) + 1
                cliAgentInfoRuns[id] = infoRun
                const info = await cliAgents.info(id, config)
                if (run !== cliAgentsRun || infoRun !== cliAgentInfoRuns[id]) return
                setCliAgentInfo(id, info)
                if (id === "dsh" && info.dsh) {
                  setState("cliAgents", id, "provider", info.dsh.provider || "deepseek-official")
                  setState("cliAgents", id, "model", info.dsh.model || "deepseek-v4-flash")
                  setState("cliAgents", id, "baseURL", info.dsh.baseURL || "")
                  setState("cliAgents", id, "hasFileApiKey", info.dsh.hasFileApiKey)
                  setState("cliAgents", id, "apiKeyEnvSet", info.dsh.apiKeyEnvSet)
                  setState("cliAgents", id, "baseUrlEnvSet", info.dsh.baseUrlEnvSet)
                  setState("cliAgents", id, "clearApiKey", false)
                  setState("cliAgents", id, "secret", true)
                  if (cliAgents.getDshApiKey) {
                    const key = await cliAgents.getDshApiKey(config).catch(() => undefined)
                    if (run !== cliAgentsRun || infoRun !== cliAgentInfoRuns[id]) return
                    setState("cliAgents", id, "apiKey", key ?? "")
                  } else {
                    setState("cliAgents", id, "apiKey", "")
                  }
                }
                setCliAgentLoading(id, "info", false)
              }),
            )
          })
          .catch(() => {
            if (run === cliAgentsRun) setCliAgentDescriptors([])
          })
          .finally(() => {
            if (run !== cliAgentsRun) return
            for (const agent of cliAgentDescriptors()) setCliAgentLoading(agent.id, { config: false, info: false })
          })
      },
    ),
  )

  const mainRoot = createMemo(() => globalSync.data.rootByDomain[mainDomain])
  const mainPath = createMemo(() => mainRoot()?.path ?? globalSync.data.path)
  const mainConfig = createMemo(() => mainRoot()?.config ?? globalSync.data.config)

  const space = createMemo<ConfigWorkspace | undefined>(() => {
    const data = workspace.latest as ConfigWorkspace | undefined
    const root = mainPath().config
    if (!data && !root) return
    if (!root) return data
    return {
      configRoot: root,
      agentsRoot: join(root, "agents"),
      skillsRoot: join(root, "skills"),
      pluginsRoot: join(root, "plugins"),
      agentsMdPath: join(root, "AGENTS.md"),
      agents: data?.agents ?? [],
      plugins: data?.plugins ?? [],
    }
  })
  const cfg = createMemo(() => mainConfig())
  const mainProviders = createMemo(() => globalSync.data.rootByDomain[mainDomain]?.provider ?? globalSync.data.provider)
  const enabledPluginKey = createMemo(() =>
    (cfg().plugin ?? [])
      .map((entry) => (Array.isArray(entry) ? entry[0] : entry))
      .map((entry) => entry.replace(/\x1f|\x1e/g, ""))
      .join("\x1e"),
  )
  const t = language.t
  const [marketSkills, setMarketSkills] = createSignal<SkillMarketLoadResult>({ skills: [] })
  const [marketSkillsLoading, setMarketSkillsLoading] = createSignal(false)
  const [marketLoadMeta, setMarketLoadMeta] = createSignal<SkillMarketLoadMeta>()
  let marketLoadRun = 0
  const customSkillMarketRepos = createMemo<SkillMarketRepo[]>(() =>
    state.skillMarketCustomRepos.map((repo) => ({
      id: skillMarketRepoID(repo),
      label: repo.repo,
      repo: repo.repo,
      branch: repo.branch,
      description: repo.branch
        ? t("config.skills.market.custom.repoDescriptionWithBranch", { branch: repo.branch })
        : t("config.skills.market.custom.repoDescription"),
      url: skillMarketRepoURL(repo),
    })),
  )
  const skillMarketRepos = createMemo<SkillMarketRepo[]>(() => [...customSkillMarketRepos(), ...SKILL_MARKET_REPOS])
  const selectedMarketRepo = createMemo(() => skillMarketRepos().find((item) => item.id === state.skillMarketRepo))

  function loadSelectedMarketRepo() {
    const repo = selectedMarketRepo()
    if (!repo) {
      setMarketSkills({ skills: [] })
      setMarketSkillsLoading(false)
      setMarketLoadMeta(undefined)
      return
    }

    const run = ++marketLoadRun
    const controller = typeof AbortController === "function" ? new AbortController() : undefined
    const slowTimer = setTimeout(() => {
      if (marketLoadRun !== run) return
      console.warn(`[skill-market] load slow repo=${repo.repo} branch=${repo.branch ?? ""}`)
      setMarketLoadMeta((meta) => (meta ? { ...meta, slow: true } : meta))
    }, SKILL_MARKET_SLOW_LOAD_MS)
    const fetcher = platform.fetch ?? fetch
    setMarketSkillsLoading(true)
    setMarketLoadMeta({
      repo: repo.label,
      slow: false,
      timeoutMs: SKILL_MARKET_LOAD_TIMEOUT_MS,
      stage: "index",
      total: 0,
      completed: 0,
      failed: 0,
    })
    console.log(
      `[skill-market] load start repo=${repo.repo} branch=${repo.branch ?? ""} id=${repo.id} fetcher=${platform.fetch ? "platform.fetch" : "window.fetch"}`,
    )
    void loadMarketSkills(repo, fetcher, controller?.signal, (progress) => {
      if (marketLoadRun !== run) return
      setMarketLoadMeta((meta) => (meta ? { ...meta, ...progress } : meta))
    })
      .then((skills) => {
        if (marketLoadRun !== run) return
        console.log(`[skill-market] load success repo=${repo.repo} branch=${repo.branch ?? ""} count=${String(skills.length)}`)
        setMarketSkills({ skills })
        if (isCustomSkillMarketRepoID(repo.id)) {
          const parsed = cleanRepoParts(repo.repo, repo.branch)
          if (parsed) {
            const next = prependSkillMarketRepo(state.skillMarketCustomRepos, parsed)
            if (!sameSkillMarketRepos(state.skillMarketCustomRepos, next)) {
              setState("skillMarketCustomRepos", next)
            }
            saveStoredSkillMarketRepos(next)
          }
        }
      })
      .catch((err: unknown) => {
        if (marketLoadRun !== run) return
        const message =
          isAbortError(err) || isSkillMarketTimeoutError(err)
            ? t("config.skills.market.loadTimeout", { seconds: String(SKILL_MARKET_LOAD_TIMEOUT_MS / 1000) })
            : err instanceof Error
              ? err.message
              : String(err)
        console.warn(`[skill-market] load failed repo=${repo.repo} branch=${repo.branch ?? ""} error=${message}`)
        setMarketSkills({ skills: [], error: message })
      })
      .finally(() => {
        clearTimeout(slowTimer)
        if (marketLoadRun !== run) return
        setMarketSkillsLoading(false)
        setMarketLoadMeta(undefined)
      })
  }

  function setCustomSkillMarketInput(value: string) {
    setState("skillMarketCustomInput", value)
    if (state.skillMarketCustomError) setState("skillMarketCustomError", "")
  }

  function loadCustomSkillMarketRepo() {
    const repo = parseSkillMarketRepoInput(state.skillMarketCustomInput)
    if (!repo) {
      setState("skillMarketCustomError", t("config.skills.market.custom.error"))
      return
    }

    batch(() => {
      setState("skillMarketCustomError", "")
      setState("skillMarketCustomRepos", (repos) => prependSkillMarketRepo(repos, repo))
      setState("skillMarketRepo", skillMarketRepoID(repo))
    })
  }

  createEffect(
    on(
      () => {
        if (state.section !== "skills" || state.skillPanel !== "market") return undefined
        const repo = selectedMarketRepo()
        if (!repo) return undefined
        return `${repo.id}\n${repo.repo}\n${repo.branch ?? ""}`
      },
      (repoKey) => {
        if (!repoKey) return
        loadSelectedMarketRepo()
      },
    ),
  )

  const setMainProviders = (provider: ProviderListResponse) => {
    const root = globalSync.data.rootByDomain[mainDomain]
    globalSync.set("rootByDomain", mainDomain, {
      ready: root?.ready ?? globalSync.data.ready,
      error: root?.error ?? globalSync.data.error,
      path: root?.path ?? globalSync.data.path,
      provider,
      provider_auth: root?.provider_auth ?? globalSync.data.provider_auth,
      config: root?.config ?? globalSync.data.config,
      reload: root?.reload ?? globalSync.data.reload,
    })
    globalSync.set("provider", provider)
  }

  function agentModeLabel(mode?: string) {
    if (mode === "subagent") return t("config.agents.badge.subagent")
    if (mode === "primary") return t("config.agents.badge.primary")
    if (mode === "all") return t("config.agents.badge.all")
    return t("config.agents.badge.agent")
  }

  function back() {
    console.debug(
      `[config-back] click dir=${params.dir ?? ""} historyLength=${window.history.length} pathname=${window.location.pathname}`,
    )
    if (!params.dir) {
      console.debug("[config-back] action=navigate target=/ replace=true reason=global-route")
      navigate("/", { replace: true })
      return
    }
    const target = `/${params.dir}/session`
    console.debug(`[config-back] action=navigate target=${target} replace=true`)
    navigate(target, { replace: true })
  }
  const clawsSectionEnabled = createMemo(() => platform.platform === "desktop")
  const querySection = createMemo<Section | undefined>(() => {
    const value = query.section
    if (typeof value === "string" && isKnownSection(value)) {
      return value as Section
    }
  })
  const opened = createMemo<LocalProject[]>(() =>
    layout.projects
      .list()
      .filter((item) => file(item.worktree))
      .sort((a, b) => (a.name ?? name(a.worktree)).localeCompare(b.name ?? name(b.worktree))),
  )
  const openedKey = createMemo(() =>
    opened()
      .map((item) =>
        [item.id, item.name ?? "", item.worktree, ...(item.sandboxes ?? [])]
          .map((part) => (part ?? "").replace(/\x1f|\x1e/g, ""))
          .join("\x1f"),
      )
      .join("\x1e"),
  )

  const agentsMd = createMemo<DocItem[]>(() => {
    if (!space()?.agentsMdPath) return []
    return [
      {
        id: "agents-md:global",
        label: t("config.agentsMd.title"),
        path: space()!.agentsMdPath!,
        editable: true,
        source: "opencode",
        note: t("config.agentsMd.note"),
      },
    ]
  })

  const globalAgents = createMemo<DocItem[]>(() =>
    (space()?.agents ?? []).map((item) => ({
      id: `agent:${item.path}`,
      label: item.name,
      path: item.path,
      editable: true,
      source: "opencode",
      group: "opencode" as const,
      origin: ".opencode",
    })),
  )

  const skills = createMemo<SkillItem[]>(() => {
    const root = local(space()?.skillsRoot ?? "")
    const claude = mainPath().home ? join(mainPath().home, ".claude", "skills") : undefined
    return (rawSkills.latest ?? []).map((item) => {
      const source = classifySkillSource(item.location, opened(), {
        opencodeRoot: root,
        claudeRoot: claude,
        allowPathFallback: false,
      })
      const group: SkillGroup = source.group === "global" ? "external" : source.group
      return {
        ...item,
        location: local(item.location),
        editable: file(item.location),
        source: group === "project" ? "project" : group === "opencode" ? "opencode" : "external",
        group,
        project: group === "project" ? source.project : undefined,
        origin: source.origin,
        root: source.root,
        warn:
          !item.name.trim() || !item.description?.trim()
            ? `Incomplete metadata. Add ${[!item.name.trim() && "`name`", !item.description?.trim() && "`description`"]
                .filter((part): part is string => !!part)
                .join(t("config.common.and"))} ${t("config.skills.warn.metadataSuffix")}`
            : undefined,
      }
    })
  })

  const claudeRoot = createMemo(() => {
    if (mainPath().home) return join(mainPath().home, ".claude", "skills")

    const hit = skills().find((item) => item.group === "claude")
    if (hit) return norm(hit.location).split("/.claude/skills/")[0] + "/.claude/skills"

    const root = home(space()?.configRoot ?? "")
    if (root) return join(root, ".claude", "skills")
  })

  const scan = async (
    root: string,
    extra: Omit<SkillItem, "name" | "description" | "location" | "content" | "editable" | "warn">,
  ) => {
    if (!platform.listConfigDirectory || !platform.readLocalFile) return [] as SkillItem[]
    if (!file(root)) return [] as SkillItem[]

    const walk = async (dir: string): Promise<SkillItem[]> => {
      const list = await platform.listConfigDirectory?.(dir).catch(() => [])
      if (!list?.length) return []

      return Promise.all(
        sortTree(list).map(async (item) => {
          if (item.kind === "directory") return walk(item.path)
          if (name(item.path) !== "SKILL.md") return []

          const text = await platform.readLocalFile?.(item.path).catch(() => null)
          if (!text) return []

          const meta = skillMeta(text, item.path)

          return [
            {
              name: meta.name,
              description: meta.description,
              location: item.path,
              content: text,
              editable: file(item.path),
              warn: meta.warn,
              ...extra,
            },
          ]
        }),
      ).then((list) => list.flat())
    }

    return walk(root)
  }

  const scanCommands = async (
    root: string,
    extra: { group: "global" | "project"; root?: string; project?: string },
  ): Promise<DocItem[]> => {
    if (!platform.listConfigDirectory || !platform.readLocalFile) return []
    if (!file(root)) return []

    const walk = async (dir: string): Promise<DocItem[]> => {
      const list = await platform.listConfigDirectory?.(dir).catch(() => [])
      if (!list?.length) return []
      return Promise.all(
        sortTree(list).map(async (item) => {
          if (item.kind === "directory") return walk(item.path)
          if (!item.path.endsWith(".md")) return []
          const text = await platform.readLocalFile?.(item.path).catch(() => null)
          if (text == null) return []
          const rel = item.path.slice(root.length + 1).replace(/\.md$/, "")
          const cmdName = rel.replace(/^(command|commands)\//, "")
          const fm = frontmatterData(text)
          return [
            {
              id: `cmd:${item.path}`,
              label: cmdName,
              path: item.path,
              editable: file(item.path),
              source: extra.group,
              note: fm?.description ?? "",
              content: text,
              group: extra.group as SkillGroup,
              root: extra.root,
              project: extra.project,
            },
          ]
        }),
      ).then((list) => list.flat())
    }
    return walk(root)
  }

  const scanCommandFolders = async (
    root: string,
    extra: { group: "global" | "project"; root?: string; project?: string },
  ): Promise<DocItem[]> => {
    return Promise.all([scanCommands(join(root, "command"), extra), scanCommands(join(root, "commands"), extra)]).then(
      (list) => list.flat(),
    )
  }

  const scanAgents = async (
    root: string,
    extra: Pick<DocItem, "source" | "group" | "project" | "origin" | "root">,
    opts?: { code?: boolean },
  ) => {
    if (!platform.listConfigDirectory) return [] as DocItem[]
    if (!file(root)) return [] as DocItem[]

    const walk = async (dir: string): Promise<DocItem[]> => {
      const list = await platform.listConfigDirectory?.(dir).catch(() => [] as ConfigTreeItem[])
      if (!list?.length) return []

      return Promise.all(
        sortTree(list).map(async (item) => {
          if (item.kind === "directory") return walk(item.path)
          const match = opts?.code ? /\.(?:mdx?|d\.ts|[cm]?[jt]s)$/i : /\.mdx?$/i
          if (!match.test(item.path)) return []

          const label = stem(rel(root, item.path))
          const text = await platform.readLocalFile?.(item.path).catch(() => null)
          const description = text ? frontmatterData(text)?.description : undefined

          return [
            {
              id: `agent:${item.path}`,
              label,
              path: item.path,
              editable: file(item.path),
              note:
                extra.group === "plugin" && opts?.code
                  ? (description ?? "Plugin agent prompt source file.")
                  : extra.group === "plugin"
                    ? (description ?? "Plugin agent prompt file.")
                    : description,
              ...extra,
            },
          ]
        }),
      ).then((list) => list.flat())
    }

    const list = await walk(root)
    return list
  }

  const [diskAgents] = createResource(
    () => (state.section === "agents" ? ([state.agentRev, openedKey()] as const) : false),
    async () => {
      const list = untrack(opened)
      return Promise.all(
        list.map(async (item) => {
          const label = item.name ?? name(item.worktree)
          const roots = projectRoots(item)

          return Promise.all(
            roots.map(async (dir) => {
              const extra = dir === item.worktree ? undefined : name(dir)
              const suffix = extra ? ` · ${extra}` : ""

              return Promise.all([
                scanAgents(join(dir, ".opencode", "agent"), {
                  source: "project",
                  group: "project",
                  project: label,
                  root: item.worktree,
                  origin: `.opencode${suffix}`,
                }),
                scanAgents(join(dir, ".opencode", "agents"), {
                  source: "project",
                  group: "project",
                  project: label,
                  root: item.worktree,
                  origin: `.opencode${suffix}`,
                }),
                scanAgents(join(dir, ".agents", "agent"), {
                  source: "project",
                  group: "project",
                  project: label,
                  root: item.worktree,
                  origin: `.agents${suffix}`,
                }),
                scanAgents(join(dir, ".agents", "agents"), {
                  source: "project",
                  group: "project",
                  project: label,
                  root: item.worktree,
                  origin: `.agents${suffix}`,
                }),
              ]).then((list) => list.flat())
            }),
          ).then((list) => list.flat())
        }),
      ).then((list) => list.flat())
    },
  )

  const [pluginAgents] = createResource(
    () =>
      state.section === "agents" ? ([state.agentRev, mainPath().home, enabledPluginKey()] as const) : false,
    async ([, home]) => {
      const plugins = untrack(() => cfg().plugin)
      const cache = home ? join(home, ".cache", "opencode") : undefined
      if (!cache || !plugins?.length) return [] as DocItem[]

      return Promise.all(
        plugins
          .map(pkg)
          .filter((item): item is { name: string; version: string } => !!item)
          .flatMap((item) => [
            {
              root: join(cache, "node_modules", item.name),
              name: item.name,
            },
            {
              root: join(cache, "packages", `${item.name}@${item.version}`, "node_modules", item.name),
              name: item.name,
            },
          ])
          .map(async (item) => {
            return Promise.all([
              scanAgents(join(item.root, "agent"), {
                source: "external",
                group: "plugin",
                origin: item.name,
                root: item.root,
              }),
              scanAgents(join(item.root, "agents"), {
                source: "external",
                group: "plugin",
                origin: item.name,
                root: item.root,
              }),
              scanAgents(join(item.root, "dist", "agents"), {
                source: "external",
                group: "plugin",
                origin: item.name,
                root: item.root,
              }),
            ]).then((list) => list.flat())
          }),
      ).then((list) => list.flat())
    },
  )

  const runtimeAgents = createMemo<DocItem[]>(() => {
    const names = new Set(
      [...globalAgents(), ...(diskAgents.latest ?? []), ...(pluginAgents.latest ?? [])].map((item) => item.label),
    )
    return configAgentDisplayItems({
      runtime: loaded.latest ?? [],
      // The server config is merged with Markdown agents. Only the file read here
      // is authoritative for the editable opencode.jsonc section.
      configured: configFileAgents(),
      definedNames: names,
    }).map((item) => {
      const local = item.origin !== "runtime"
      return {
        id: `agent-runtime:${item.name}`,
        label: item.name,
        path: item.origin === "config" ? `config:agent.${item.name}` : `runtime:${item.name}`,
        editable: false,
        source: local ? "opencode" : "external",
        group:
          item.origin === "built-in"
            ? ("builtin" as const)
            : item.origin === "config"
              ? ("config" as const)
              : local
                ? ("opencode" as const)
                : ("plugin" as const),
        origin: item.origin === "built-in" ? "built-in" : item.origin === "config" ? "opencode.jsonc" : "runtime",
        note: item.description,
        content: item.prompt ?? "No prompt content is available for this runtime agent.",
      }
    })
  })
  const loadedMap = createMemo(
    () => new Map((loaded.latest ?? ([] as Agent[])).map((item) => [item.name, item] as const)),
  )

  const agents = createMemo<DocItem[]>(() => {
    const seen = new Set<string>()
    return [...globalAgents(), ...(diskAgents.latest ?? []), ...(pluginAgents.latest ?? []), ...runtimeAgents()]
      .filter((item) => {
        const key = norm(item.path)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "") || a.label.localeCompare(b.label))
  })

  const agentMatches = (item: DocItem) =>
    skillSearchMatch(
      [
        item.label,
        loadedMap().get(item.label)?.description,
        item.note,
        item.path,
        item.project,
        item.origin,
        item.source,
      ],
      state.agentQuery,
    )
  const agentOpenCode = createMemo(() => agents().filter((item) => item.group === "opencode" && agentMatches(item)))
  const agentBuiltIn = createMemo(() => agents().filter((item) => item.group === "builtin" && agentMatches(item)))
  const agentConfig = createMemo(() => agents().filter((item) => item.group === "config" && agentMatches(item)))
  const agentProject = createMemo(() => agents().filter((item) => item.group === "project" && agentMatches(item)))
  const agentPlugin = createMemo(() => agents().filter((item) => item.group === "plugin" && agentMatches(item)))

  const projectAgentGroups = createMemo(() => {
    const items = agentProject()
    const groups = new Map<string, DocItem[]>()
    for (const item of items) {
      const key = item.project ?? ""
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(item)
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })

  const agentProjectOpen = (key: string) => !!state.treeClosed[`agent-project:${key}`]
  const toggleAgentProject = (key: string) => setState("treeClosed", `agent-project:${key}`, (v) => !v)

  const [diskClaude] = createResource(
    () => (state.section === "skills" ? ([state.skillRev, claudeRoot()] as const) : false),
    async ([, root]) => {
      if (!root) return [] as SkillItem[]
      return scan(root, { source: "external", group: "claude", origin: ".claude" })
    },
  )

  const [diskOpenCode] = createResource(
    () => (state.section === "skills" ? ([state.skillRev, space()?.skillsRoot] as const) : false),
    async ([, root]) => {
      if (!root) return [] as SkillItem[]
      return scan(root, { source: "opencode", group: "opencode", origin: ".opencode" })
    },
  )

  const [diskProject] = createResource(
    () => (state.section === "skills" ? ([state.skillRev, openedKey()] as const) : false),
    async () => {
      const list = untrack(opened)
      return Promise.all(
        list.map(async (item) => {
          const label = item.name ?? name(item.worktree)
          const roots = projectRoots(item)

          return Promise.all(
            roots.map(async (dir) => {
              const extra = dir === item.worktree ? undefined : name(dir)
              return Promise.all([
                scan(join(dir, ".opencode", "skill"), {
                  source: "project",
                  group: "project",
                  project: label,
                  root: item.worktree,
                  origin: extra ? `.opencode · ${extra}` : ".opencode",
                }),
                scan(join(dir, ".opencode", "skills"), {
                  source: "project",
                  group: "project",
                  project: label,
                  root: item.worktree,
                  origin: extra ? `.opencode · ${extra}` : ".opencode",
                }),
                scan(join(dir, ".claude", "skills"), {
                  source: "project",
                  group: "project",
                  project: label,
                  root: item.worktree,
                  origin: extra ? `.claude · ${extra}` : ".claude",
                }),
                scan(join(dir, ".agents", "skills"), {
                  source: "project",
                  group: "project",
                  project: label,
                  root: item.worktree,
                  origin: extra ? `.agents · ${extra}` : ".agents",
                }),
              ]).then((list) => list.flat())
            }),
          ).then((list) => list.flat())
        }),
      ).then((list) => list.flat())
    },
  )

  const skillDocs = createMemo<DocItem[]>(() => {
    const seen = new Set<string>()
    return [...skills(), ...(diskOpenCode.latest ?? []), ...(diskClaude.latest ?? []), ...(diskProject.latest ?? [])]
      .filter((item) => {
        const key = norm(item.location)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((item) => ({
        id: `skill:${item.location}`,
        label: item.name,
        path: item.location,
        editable: item.editable,
        source: item.source,
        note: item.description,
        content: item.editable ? undefined : item.content,
        warn: item.warn,
        group: item.group,
        project: item.project,
        origin: item.origin,
        root: item.root,
      }))
  })

  const globalCommandsDir = createMemo(() => space()?.configRoot)
  const [diskGlobalCmds] = createResource(
    () => (state.section === "commands" ? ([state.commandRev, globalCommandsDir()] as const) : false),
    async ([, dir]) => {
      console.info("[config-perf] fetch diskGlobalCmds start")
      const started = performance.now()
      const result = dir ? await scanCommandFolders(dir, { group: "global", root: dir }) : []
      console.info(`[config-perf] fetch diskGlobalCmds done ms=${(performance.now() - started).toFixed(1)}`)
      return result
    },
  )
  const [diskProjectCmds] = createResource(
    () => (state.section === "commands" ? ([state.commandRev, openedKey()] as const) : false),
    async () => {
      console.info("[config-perf] fetch diskProjectCmds start")
      const started = performance.now()
      const list = untrack(opened)
      const projects = new Map<string, { root: string; label: string }>()
      for (const item of list) {
        projects.set(norm(item.worktree), { root: item.worktree, label: item.name ?? name(item.worktree) })
      }
      const result = await Promise.all(
        Array.from(projects.values()).map(async (item) => {
          const dir = join(item.root, ".opencode")
          return scanCommandFolders(dir, { group: "project", root: item.root, project: item.label })
        }),
      ).then((results) => results.flat())
      console.info(`[config-perf] fetch diskProjectCmds done ms=${(performance.now() - started).toFixed(1)}`)
      return result
    },
  )

  const commandDocs = createMemo(() => [...(diskGlobalCmds.latest ?? []), ...(diskProjectCmds.latest ?? [])])
  const commandMatches = (item: DocItem) =>
    skillSearchMatch([item.label, item.note, item.path, item.project, item.root, item.source], state.commandQuery)
  const commandGlobal = createMemo(() =>
    (diskGlobalCmds.latest ?? []).filter((item) => item.group === "global" && commandMatches(item)),
  )
  const commandProject = createMemo(() =>
    (diskProjectCmds.latest ?? []).filter((item) => item.group === "project" && commandMatches(item)),
  )

  const projectCommands = createMemo(() => {
    const map = new Map<string, { label: string; path?: string; items: DocItem[] }>()
    for (const item of commandProject()
      .slice()
      .sort((a, b) => (a.project ?? "").localeCompare(b.project ?? "") || a.label.localeCompare(b.label))) {
      const key = item.root ?? item.project ?? item.path
      const prev = map.get(key)
      if (prev) {
        prev.items.push(item)
        continue
      }
      map.set(key, {
        label: item.project ?? name(item.root ?? item.path),
        path: item.root,
        items: [item],
      })
    }
    if (
      state.pick === COMMAND_NEW &&
      state.cmdCreateProjectRoot &&
      skillSearchMatch([state.cmdTitle], state.commandQuery)
    ) {
      const key = state.cmdCreateProjectRoot
      const safeName = commandSafeName(state.cmdTitle)
      const label = safeName || state.cmdTitle.trim() || t("config.commands.create.action")
      const path = join(state.cmdCreateDir, `${safeName || "command"}.md`)
      const item: DocItem = {
        id: COMMAND_NEW,
        label,
        path,
        editable: true,
        source: "project",
        group: "project",
        project: state.cmdCreateProjectLabel || name(state.cmdCreateProjectRoot),
        root: state.cmdCreateProjectRoot,
      }
      const prev = map.get(key)
      if (prev) prev.items = [item, ...prev.items.filter((entry) => entry.id !== COMMAND_NEW)]
      else {
        map.set(key, {
          label: state.cmdCreateProjectLabel || name(state.cmdCreateProjectRoot),
          path: state.cmdCreateProjectRoot,
          items: [item],
        })
      }
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label))
  })

  const commandProjectOpen = (key: string) => !!state.treeClosed[`cmd-project:${key}`]
  const toggleCommandProject = (key: string) => setState("treeClosed", `cmd-project:${key}`, (v) => !v)

  const commandLoading = createMemo(
    () =>
      state.section === "commands" && (diskGlobalCmds.loading || diskProjectCmds.loading) && commandDocs().length === 0,
  )

  const skillQueryText = createMemo(() => state.skillQuery.trim())
  const skillMatches = (item: DocItem) => {
    const query = skillQueryText()
    if (!query) return true
    return skillSearchMatch([item.label, item.note, item.path, item.project, item.origin, item.source], query)
  }
  const skillOpenCode = createMemo(() => skillDocs().filter((item) => item.group === "opencode" && skillMatches(item)))
  const skillClaude = createMemo(() => skillDocs().filter((item) => item.group === "claude" && skillMatches(item)))
  const skillProject = createMemo(() => skillDocs().filter((item) => item.group === "project" && skillMatches(item)))
  const skillExternal = createMemo(() => skillDocs().filter((item) => item.group === "external" && skillMatches(item)))
  const installedGlobalSkillFolders = createMemo(() => {
    const folders = new Set<string>()
    const add = (location: string) => folders.add(name(dir(local(location))).toLowerCase())
    for (const item of diskOpenCode.latest ?? []) add(item.location)
    return folders
  })
  const skillMarketProjectTargets = createMemo<SkillMarketProjectTarget[]>(() =>
    opened().map((project) => {
      const root = project.worktree
      const base = `${norm(root)}/.opencode/skills/`
      const installed = new Set<string>()
      for (const item of diskProject.latest ?? []) {
        const next = norm(local(item.location))
        if (next.startsWith(base)) installed.add(name(dir(next)).toLowerCase())
      }
      return {
        label: project.name ?? name(root),
        root,
        installed,
      }
    }),
  )
  const projectSkills = createMemo(() => {
    const map = new Map<string, { label: string; path?: string; items: DocItem[] }>()

    for (const item of skillProject()
      .slice()
      .sort((a, b) => (a.project ?? "").localeCompare(b.project ?? "") || a.label.localeCompare(b.label))) {
      const key = item.root ?? item.project ?? item.path
      const prev = map.get(key)
      if (prev) {
        prev.items.push(item)
        continue
      }
      map.set(key, {
        label: item.project ?? name(item.root ?? item.path),
        path: item.root,
        items: [item],
      })
    }
    if (state.pick === SKILL_NEW && state.skillCreateProjectRoot) {
      const key = state.skillCreateProjectRoot
      const title = state.skillTitle.trim()
      const label = title || t("config.skills.create.action")
      const path = join(state.skillCreateRoot, title || "skill", "SKILL.md")
      const item: DocItem = {
        id: SKILL_NEW,
        label,
        path,
        editable: true,
        source: "project",
        group: "project",
        project: state.skillCreateProjectLabel || name(state.skillCreateProjectRoot),
        root: state.skillCreateProjectRoot,
      }
      const prev = map.get(key)
      if (prev) prev.items = [item, ...prev.items.filter((entry) => entry.id !== SKILL_NEW)]
      else {
        map.set(key, {
          label: state.skillCreateProjectLabel || name(state.skillCreateProjectRoot),
          path: state.skillCreateProjectRoot,
          items: [item],
        })
      }
    }

    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label))
  })

  const scanPlugins = async (root: string, extra: PluginSource): Promise<PluginItem[]> => {
    if (!platform.listConfigDirectory) return []
    if (!file(root)) return []

    const walk = async (dir: string): Promise<PluginItem[]> => {
      const list = await platform.listConfigDirectory?.(dir).catch(() => [] as ConfigTreeItem[])
      if (!list?.length) return []

      return Promise.all(
        sortTree(list).map(async (item) => {
          if (item.kind === "directory") return walk(item.path)
          if (!/\.(?:ts|js|mjs|cjs|mts|cts)$/i.test(item.path)) return []

          const key = pluginKey(item.path)
          return [
            {
              id: `plugin:${key}`,
              label: plugin(item.path),
              name: plugin(item.path),
              enabled: false,
              exists: true,
              path: item.path,
              spec: spec(item.path),
              ...extra,
            },
          ]
        }),
      ).then((list) => list.flat())
    }

    return walk(root)
  }

  const [diskProjectPlugins] = createResource(
    () => (state.section === "plugins" ? ([state.pluginRev, openedKey()] as const) : false),
    async () => {
      console.info("[config-perf] fetch diskProjectPlugins start")
      const started = performance.now()
      const list = untrack(opened)
      const result = await Promise.all(
        list.map(async (item) => {
          const label = item.name ?? name(item.worktree)
          const roots = projectRoots(item)

          return Promise.all(
            roots.map(async (dir) => {
              const extra = dir === item.worktree ? undefined : name(dir)
              const suffix = extra ? ` · ${extra}` : ""

              return Promise.all([
                scanPlugins(join(dir, ".opencode", "plugin"), {
                  group: "project",
                  project: label,
                  root: item.worktree,
                  origin: `.opencode${suffix}`,
                }),
                scanPlugins(join(dir, ".opencode", "plugins"), {
                  group: "project",
                  project: label,
                  root: item.worktree,
                  origin: `.opencode${suffix}`,
                }),
                scanPlugins(join(dir, ".agents", "plugin"), {
                  group: "project",
                  project: label,
                  root: item.worktree,
                  origin: `.agents${suffix}`,
                }),
                scanPlugins(join(dir, ".agents", "plugins"), {
                  group: "project",
                  project: label,
                  root: item.worktree,
                  origin: `.agents${suffix}`,
                }),
              ]).then((list) => list.flat())
            }),
          ).then((list) => list.flat())
        }),
      ).then((list) => list.flat())
      console.info(
        `[config-perf] fetch diskProjectPlugins done ms=${(performance.now() - started).toFixed(1)} count=${String(result.length)}`,
      )
      return result
    },
  )

  const [projectPluginConfigs, setProjectPluginConfigs] = createSignal<NonNullable<Config["plugin"]>>([])
  let projectPluginConfigsRun = 0
  createEffect(
    on(
      () => [state.section, state.pluginRev, openedKey()] as const,
      ([section]) => {
        if (section !== "plugins") return
        const run = ++projectPluginConfigsRun
        console.info("[config-perf] fetch projectPluginConfigs start")
        const started = performance.now()
        void (async () => {
          const projects = untrack(opened)
          const configs = await Promise.allSettled(
            projects.flatMap((project) =>
              projectRoots(project).map(async (directory) => {
                const client = globalSDK.forDomain(mainDomain).createClient({ directory, throwOnError: true })
                const result = await client.config.get()
                return result.data?.plugin ?? []
              }),
            ),
          )
          if (run !== projectPluginConfigsRun) return
          setProjectPluginConfigs(configs.flatMap((result) => (result.status === "fulfilled" ? result.value : [])))
          console.info(
            `[config-perf] fetch projectPluginConfigs done ms=${(performance.now() - started).toFixed(1)}`,
          )
        })()
      },
      { defer: false },
    ),
  )

  const configuredPlugins = createMemo(() => [...(cfg().plugin ?? []), ...projectPluginConfigs()])

  const plugins = createMemo<PluginItem[]>(() => {
    const on = configuredPlugins()
    const map = new Map<string, PluginItem>()

    for (const item of space()?.plugins ?? []) {
      const key = pluginKey(item.path)
      map.set(key, {
        id: `plugin:${key}`,
        label: item.name,
        name: key,
        enabled: false,
        exists: true,
        path: item.path,
        spec: spec(item.path),
        group: "global",
        origin: ".opencode",
        root: space()?.configRoot,
      })
    }

    for (const item of diskProjectPlugins.latest ?? []) {
      const key = pluginKey(item.path ?? item.name)
      const existing = map.get(key)
      map.set(key, {
        ...item,
        enabled: existing?.enabled ?? false,
        spec: existing?.spec ?? item.spec,
      })
    }

    for (const entry of on) {
      const spec = Array.isArray(entry) ? entry[0] : entry
      const key = pluginKey(spec)
      const item = map.get(key)
      if (item) {
        item.enabled = true
        item.spec = spec
        map.set(key, item)
        continue
      }

      const project = classifyPluginSource(spec, opened(), { allowPathFallback: false })

      map.set(key, {
        id: `plugin:${key}`,
        label: plugin(spec),
        name: plugin(spec),
        enabled: true,
        exists: file(spec),
        spec,
        path: file(spec) ? local(spec) : undefined,
        group: project.scope === "project" ? "project" : "global",
        project: project.scope === "project" ? project.project : undefined,
        root: project.root,
        origin: project.origin,
      })
    }

    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  })

  const pluginMatches = (item: PluginItem) =>
    skillSearchMatch(
      [item.label, item.name, item.path, item.spec, item.project, item.origin, item.root],
      state.pluginQuery,
    )
  const pluginGlobal = createMemo(() =>
    (plugins() ?? []).filter((item) => item.group !== "project" && pluginMatches(item)),
  )
  const pluginProject = createMemo(() =>
    (plugins() ?? []).filter((item) => item.group === "project" && pluginMatches(item)),
  )
  const projectPlugins = createMemo(() => {
    const map = new Map<string, { label: string; path?: string; items: PluginItem[] }>()

    for (const item of pluginProject()
      .slice()
      .sort((a, b) => (a.project ?? "").localeCompare(b.project ?? "") || a.label.localeCompare(b.label))) {
      const key = item.root ?? item.project ?? item.path ?? item.name
      const prev = map.get(key)
      if (prev) {
        prev.items.push(item)
        continue
      }
      map.set(key, {
        label: item.project ?? name(item.root ?? item.path ?? item.name),
        path: item.root,
        items: [item],
      })
    }

    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label))
  })

  const claws = createMemo<ClawItem[]>(() => {
    if (platform.platform !== "desktop") return []
    const items: ClawItem[] = extraAgents.map((agent) => {
      if (agent.id === "openclaw") {
        const cfg = openclawConfig()
        return {
          id: "claw:openclaw",
          label: agent.label,
          note: t("config.claws.note.openclaw"),
          meta: cfg?.url?.trim() || "ws://127.0.0.1:18789",
          sourceUrl: agent.sourceUrl,
          enabled: cfg?.enabled ?? false,
        }
      }
      if (agent.id === "hermes") {
        const cfg = hermesConfig()
        return {
          id: "claw:hermes",
          label: agent.label,
          note: t("config.claws.note.hermes"),
          meta: cfg?.hermesDir?.trim() || "/path/to/hermes-agent",
          sourceUrl: agent.sourceUrl,
          enabled: cfg?.enabled ?? false,
        }
      }
      const cfg = genericagentConfig()
      return {
        id: "claw:genericagent",
        label: agent.label,
        note: t("config.claws.note.genericagent"),
        meta: cfg?.genericAgentDir?.trim() || "/path/to/GenericAgent",
        sourceUrl: agent.sourceUrl,
        enabled: cfg?.enabled ?? false,
      }
    })
    for (const agent of cliAgentDescriptors()) {
      const config = cliAgentConfigs[agent.id]
      const info = cliAgentInfo[agent.id]
      const model = info?.details?.find((detail) => detail.label === "Model")?.value ?? info?.dsh?.model
      items.push({
        id: `claw:${agent.id}`,
        label: agent.label,
        meta: `${agent.command} CLI · ${model ?? t("config.claws.info.unknown")}`,
        sourceUrl: agent.sourceUrl,
        enabled: config?.enabled ?? true,
      })
    }
    return items
  })

  const pluginDocs = createMemo<DocItem[]>(() =>
    (plugins() ?? [])
      .filter((item) => !!item.path)
      .map((item) => ({
        id: item.id,
        label: item.label,
        path: item.path!,
        editable: true,
        source: "opencode",
        note: undefined,
      })),
  )

  const providers = createMemo<ProviderItem[]>(() => {
    const started = performance.now()
    const data = mainProviders()
    const items = collectConfigProviders({
      all: data.all,
      connected: data.connected ?? [],
      disabled: cfg().disabled_providers ?? [],
      configProviders: cfg().provider,
    })
    console.info(
      `[config-perf] providers memo all=${String(data.all.length)} connected=${String((data.connected ?? []).length)} items=${String(items.length)} collectMs=${(performance.now() - started).toFixed(1)} sinceClick=${configPerfSinceClick()}`,
    )
    return items
  })

  const providerList = createMemo(() => {
    const result = providers().filter((item) => fuzzy(item.id, state.query))
    return result
  })
  const providerOn = createMemo(() => {
    const result = providerList().filter((item) => providerEnabled(item))
    return result
  })
  const providerOff = createMemo(() => {
    const result = providerList().filter((item) => !providerEnabled(item))
    return result
  })
  const providerVisible = createMemo(() => [...providerOn(), ...providerOff()])
  // Searching: auto-expand "未启用" so filtered matches are visible without a manual click.
  // Clearing search restores the user's collapsed preference (default collapsed).
  const providerOffExpanded = createMemo(() => state.query.trim().length > 0 || !state.providerOffCollapsed)

  createEffect(() => {
    if (state.section !== "providers") return
    const searching = state.query.trim().length > 0
    const onCount = providerOn().length
    const offCount = providerOff().length
    const total = providerList().length
    console.info(
      `[config-perf] middle provider-list ready on=${String(onCount)} off=${String(offCount)} total=${String(total)} sinceClick=${configPerfSinceClick()}`,
    )
    console.info(
      `[config] providerOffExpanded searching=${String(searching)} collapsed=${String(state.providerOffCollapsed)} offCount=${String(offCount)} expanded=${String(providerOffExpanded())}`,
    )
  })

  const docs = createMemo(() => {
    const map = new Map<string, DocItem>()
    for (const item of [...agentsMd(), ...agents(), ...skillDocs(), ...pluginDocs(), ...commandDocs()])
      map.set(item.id, item)
    return map
  })

  const currentDoc = createMemo(() => {
    if (state.section === "agents-md") return agentsMd().find((item) => item.id === state.doc)
    if (state.section === "agents") return agents().find((item) => item.id === state.doc)
    if (state.section === "plugins") return pluginDocs().find((item) => item.id === state.doc)
    if (state.section === "commands") {
      const item = commandDocs().find((item) => item.id === state.doc)
      if (item) return item
      if (state.doc !== `cmd:${state.cmdPath}` || !state.cmdPath) return
      const isProject = !!state.cmdCreateProjectRoot
      return {
        id: `cmd:${state.cmdPath}`,
        label: state.cmdTitle.trim() || name(dir(state.cmdPath)),
        path: state.cmdPath,
        editable: true,
        source: isProject ? "project" : "global",
        group: isProject ? ("project" as const) : ("global" as const),
        root: isProject ? state.cmdCreateProjectRoot : space()?.configRoot,
        project: isProject ? state.cmdCreateProjectLabel : undefined,
      }
    }
    if (state.section !== "skills") return

    const item = skillDocs().find((item) => item.id === state.doc)
    if (item) return item
    if (state.doc !== state.skillPath || !state.skillPath) return
    const isProject = !!state.skillCreateProjectRoot
    return {
      id: `skill:${state.skillPath}`,
      label: state.skillTitle.trim() || name(dir(state.skillPath)),
      path: state.skillPath,
      editable: true,
      source: isProject ? "project" : "opencode",
      note: state.skillNote || undefined,
      warn: state.skillWarn || undefined,
      group: isProject ? ("project" as const) : ("opencode" as const),
      root: isProject ? state.skillCreateProjectRoot : undefined,
      project: isProject ? state.skillCreateProjectLabel : undefined,
    }
  })
  const currentPlugin = createMemo(() => plugins()?.find((item) => item.id === state.doc))
  const currentAgent = createMemo(() => agents().find((item) => item.id === state.doc))
  const currentJsoncAgent = createMemo(() => {
    const item = currentAgent()
    if (!item?.path.startsWith("config:agent.")) return
    return item.path.slice("config:agent.".length)
  })
  const currentSkill = createMemo(() => skillDocs().find((item) => item.id === state.doc))
  const selectedProvider = createMemo(() =>
    providers().find((item) => item.id === state.pick.replace(/^provider:/, "")),
  )
  const selectedPlugin = createMemo(() => plugins()?.find((item) => item.id === state.pick))
  const selectedClaw = createMemo(() => claws().find((item) => item.id === state.pick))
  const selectedExtraAgentId = createMemo(() => {
    if (selectedClaw()?.id === "claw:openclaw") return "openclaw" as const
    if (selectedClaw()?.id === "claw:hermes") return "hermes" as const
    if (selectedClaw()?.id === "claw:genericagent") return "genericagent" as const
  })
  const selectedExtraAgentConfig = createMemo(() => {
    const id = selectedExtraAgentId()
    if (id === "openclaw") return openclawConfig()
    if (id === "hermes") return hermesConfig()
    if (id === "genericagent") return genericagentConfig()
  })
  const selectedExtraAgentConfigReady = createMemo(() => {
    const id = selectedExtraAgentId()
    if (!id) return false
    if (id === "openclaw") return !platform.getOpenclawConfig || (!!openclawConfig() && !openclawLoading())
    if (id === "hermes") return !platform.getHermesConfig || (!!hermesConfig() && !hermesLoading())
    if (id === "genericagent")
      return !platform.getGenericagentConfig || (!!genericagentConfig() && !genericagentLoading())
    return false
  })
  const [extraAgentInfoState, setExtraAgentInfoState] = createSignal<ExtraAgentInfo>()
  const [extraAgentInfoLoading, setExtraAgentInfoLoading] = createSignal(false)
  let extraAgentInfoRun = 0

  createEffect(
    on(
      () =>
        [state.section, selectedExtraAgentId(), selectedExtraAgentConfigReady(), selectedExtraAgentConfig()] as const,
      ([section, id, ready, config]) => {
        if (section !== "claws" || !id || !platform.getExtraAgentInfo || !ready) {
          extraAgentInfoRun++
          setExtraAgentInfoLoading(false)
          setExtraAgentInfoState(undefined)
          return
        }
        const run = ++extraAgentInfoRun
        setExtraAgentInfoState(undefined)
        setExtraAgentInfoLoading(true)
        void platform
          .getExtraAgentInfo(id, config)
          .then((result) => {
            if (run !== extraAgentInfoRun) return
            setExtraAgentInfoState(result)
          })
          .finally(() => {
            if (run !== extraAgentInfoRun) return
            setExtraAgentInfoLoading(false)
          })
      },
    ),
  )
  const selectedCustom = createMemo(() =>
    providers().find((item) => item.id === state.pick.replace(/^provider:/, "") && item.custom),
  )
  const dirty = createMemo(() => !!currentDoc() && state.doc === state.pick && state.text !== state.saved)
  const clawDirty = createMemo(() => {
    const cfg = openclawConfig()
    if (!cfg || state.section !== "claws") return false
    return (
      state.claw.enabled !== (cfg.enabled ?? false) ||
      state.claw.url.trim() !== (cfg.url?.trim() ?? "") ||
      state.claw.token.trim() !== (cfg.token?.trim() ?? "")
    )
  })

  const gaDirty = createMemo(() => {
    const cfg = genericagentConfig()
    if (!cfg || state.section !== "claws") return false
    return (
      state.ga.enabled !== (cfg.enabled ?? false) ||
      state.ga.pythonExecutable.trim() !== (cfg.pythonExecutable?.trim() ?? "") ||
      state.ga.genericAgentDir.trim() !== (cfg.genericAgentDir?.trim() ?? "")
    )
  })

  const cliAgentDirty = (id: CliAgentID) => {
    const config = cliAgentConfigs[id]
    const form = state.cliAgents[id]
    if (!config || !form || state.section !== "claws") return false
    const baseDirty =
      form.enabled !== (config.enabled ?? true) ||
      form.binaryPath.trim() !== (config.binaryPath?.trim() ?? "") ||
      form.configHome.trim() !== (config.configHome?.trim() ?? "")
    if (id !== "dsh") return baseDirty
    const info = cliAgentInfo[id]?.dsh
    const providerDirty = form.provider.trim() !== (info?.provider?.trim() || "deepseek-official")
    const modelDirty = form.model.trim() !== (info?.model?.trim() || "deepseek-v4-flash")
    const baseUrlDirty = form.baseURL.trim() !== (info?.baseURL?.trim() || "")
    const keyDirty = !!form.apiKey.trim() || form.clearApiKey
    return baseDirty || providerDirty || modelDirty || baseUrlDirty || keyDirty
  }

  const hmDirty = createMemo(() => {
    const cfg = hermesConfig()
    if (!cfg || state.section !== "claws") return false
    return (
      state.hm.enabled !== (cfg.enabled ?? false) ||
      state.hm.pythonExecutable.trim() !== (cfg.pythonExecutable?.trim() ?? "") ||
      state.hm.hermesDir.trim() !== (cfg.hermesDir?.trim() ?? "") ||
      state.hm.hermesHome.trim() !== (cfg.hermesHome?.trim() ?? "")
    )
  })

  const currentSkillRoot = createMemo(() => {
    const item = currentSkill()
    if (!item) return undefined
    return dir(item.path)
  })
  const agentWait = createMemo(
    () =>
      state.section === "agents" &&
      (loaded.loading || diskAgents.loading || pluginAgents.loading) &&
      agents().length === 0,
  )
  const skillWait = createMemo(
    () =>
      state.section === "skills" &&
      state.skillPanel !== "market" &&
      state.pick !== SKILL_NEW &&
      (rawSkills.loading || diskClaude.loading || diskOpenCode.loading || diskProject.loading) &&
      skillDocs().length === 0,
  )
  const pluginWait = createMemo(
    () => state.section === "plugins" && diskProjectPlugins.loading && (plugins()?.length ?? 0) === 0,
  )

  async function walk(root: string, depth = 0): Promise<TreeNode[]> {
    if (!platform.listConfigDirectory) return []
    if (!file(root)) return []
    const skip = new Set([".git", ".DS_Store", "node_modules", "dist", "build", "coverage"])
    return platform
      .listConfigDirectory(root)
      .then((list) =>
        Promise.all(
          sortTree(list)
            .filter((item) => !skip.has(name(item.path)))
            .map(async (item) => {
              const kind: TreeNode["kind"] = item.kind === "directory" ? "directory" : "file"
              return {
                path: item.path,
                kind,
                kids: kind === "directory" && depth < 2 ? await walk(item.path, depth + 1) : [],
              }
            }),
        ),
      )
      .catch(() => [])
  }

  function loadDoc(item: DocItem) {
    const hit = item.content ?? cache.get(item.path)
    if (hit !== undefined) return Promise.resolve(hit)
    const prev = pending.get(item.path)
    if (prev) return prev
    const next = (
      (platform.readLocalFile?.(item.path).catch(() => "") as Promise<string | null | undefined>) ??
      Promise.resolve("")
    ).then((text) => {
      const value = text ?? ""
      cache.set(item.path, value)
      return value
    })
    pending.set(item.path, next)
    void next.finally(() => {
      pending.delete(item.path)
    })
    return next
  }

  function loadTree(root: string) {
    const hit = trees.get(root)
    if (hit) return Promise.resolve(hit)
    const prev = treePending.get(root)
    if (prev) return prev
    const next = walk(root).then((list) => {
      trees.set(root, list)
      return list
    })
    treePending.set(root, next)
    void next.finally(() => {
      treePending.delete(root)
    })
    return next
  }

  const [tree] = createResource(currentSkillRoot, async (root) => ({ root, list: await loadTree(root) }))
  const currentTree = createMemo(() => {
    const root = currentSkillRoot()
    const value = tree.latest
    if (!root || value?.root !== root) return []
    return value.list
  })
  const treeOpen = (path: string) => !state.treeClosed[path]
  const toggleTree = (path: string) => setState("treeClosed", path, (value) => !value)
  const groupOpen = (key: string) => !!state.treeClosed[`skill-group:${key}`]
  const toggleGroup = (key: string) => setState("treeClosed", `skill-group:${key}`, (value) => !value)

  createEffect(
    on(
      () => openclawConfig(),
      (item) => {
        if (!item) return
        setState("claw", clawCfg(item))
      },
    ),
  )

  createEffect(
    on(
      () => genericagentConfig(),
      (item) => {
        if (!item) return
        setState("ga", gaCfg(item))
      },
    ),
  )

  createEffect(
    on(
      () => hermesConfig(),
      (item) => {
        if (!item) return
        setState("hm", hmCfg(item))
      },
    ),
  )

  createEffect(() => {
    const section = querySection()
    const pick = query.pick
    if (!section) return
    if (section === "claws" && platform.platform !== "desktop") return
    batch(() => {
      setState("section", section)
      if (section === "skills") setState("skillPanel", "editor")
      if (typeof pick === "string") setState("pick", pick)
      else if (section === "claws") setState("pick", "")
    })
  })

  function keepSkillsScroll(run: () => void) {
    const top = skillsList?.scrollTop ?? 0
    run()
    requestAnimationFrame(() => {
      if (skillsList) skillsList.scrollTop = top
    })
  }

  function picks(section: Section) {
    if (!section) return []
    if (section === "agents-md") return agentsMd().map((item) => item.id)
    if (section === "providers") {
      const list = providerVisible().map((item) => `provider:${item.id}`)
      if (state.pick === CUSTOM_NEW) return [CUSTOM_NEW, ...list]
      return list.length > 0 ? list : [CUSTOM_NEW]
    }
    if (section === "agents") return agents().map((item) => item.id)
    if (section === "claws") return claws().map((item) => item.id)
    if (section === "skills") {
      const list = skillDocs().map((item) => item.id)
      return state.pick === SKILL_NEW ? [SKILL_NEW, ...list] : list
    }
    if (section === "commands") {
      const list = commandDocs().map((item) => item.id)
      if (state.cmdPath && state.pick === `cmd:${state.cmdPath}` && !list.includes(state.pick)) {
        return [state.pick, ...list]
      }
      return state.pick === COMMAND_NEW ? [COMMAND_NEW, ...list] : list
    }
    if (section === "mcp") {
      const list = [...mcpGlobal(), ...mcpProject()].map((server) => server.id)
      return state.pick === MCP_NEW ? [MCP_NEW, ...list] : list
    }
    if (section === "channels") {
      return CHANNEL_PLATFORMS.map((p) => channelPick(p))
    }
    return (plugins() ?? []).map((item) => item.id)
  }

  async function jump(section: Section) {
    const run = ++jumpRun
    if (section === "claws") {
      batch(() => {
        setState("section", section)
        setState("pick", "")
        setState({ doc: "", text: "", saved: "", busy: false })
      })
      return
    }
    const list = picks(section)
    const next = list[0] ?? ""
    if (list.includes(state.pick)) {
      setState("section", section)
      return
    }
    const item = docs().get(next)
    const root = section === "skills" && item ? dir(item.path) : undefined
    const text = item ? (item.content ?? cache.get(item.path)) : undefined
    const tree = root ? trees.get(root) : undefined
    if (item && (text === undefined || (root && !tree))) {
      const values = await Promise.all([loadDoc(item), root ? loadTree(root) : Promise.resolve(undefined)])
      if (jumpRun !== run) return
      batch(() => {
        setState("section", section)
        setState("pick", next)
        setState({ doc: item.id, busy: false, text: values[0], saved: values[0] })
      })
      return
    }
    batch(() => {
      setState("section", section)
      setState("pick", next)
      if (item && text !== undefined) {
        setState({ doc: item.id, busy: false, text, saved: text })
      }
    })
    if (!item || text !== undefined) return
    void open(item)
  }

  function sidebarSections() {
    return CORE_SECTIONS.filter((section) => section !== "claws" || clawsSectionEnabled())
  }

  function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false
    if (target.isContentEditable) return true
    const tag = target.tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
    return !!target.closest("[contenteditable='true'], input, textarea, select, [role='textbox']")
  }

  function selectMiddlePick(id: string) {
    if (!id) return
    if (state.section === "claws") {
      selectClaw(id)
      return
    }
    if (id === CUSTOM_NEW || id.startsWith("provider:")) {
      setState("pick", id)
      return
    }
    if (id === MCP_NEW || id.startsWith("mcp:")) {
      setState("pick", id)
      return
    }
    if (id.startsWith("channel:")) {
      setState("pick", id)
      return
    }
    if (id === COMMAND_NEW || id === SKILL_NEW) {
      setState("pick", id)
      return
    }
    const item = docs().get(id)
    if (item) {
      void open(item)
      return
    }
    setState("pick", id)
  }

  function moveMiddle(delta: number) {
    const list = picks(state.section)
    if (list.length === 0) return
    const current = list.indexOf(state.pick)
    const index = current < 0 ? 0 : (current + delta + list.length) % list.length
    selectMiddlePick(list[index] ?? "")
  }

  function moveLeft(delta: number) {
    const list = sidebarSections()
    if (list.length === 0) return
    const current = list.indexOf(state.section as CoreSection)
    const index = current < 0 ? 0 : (current + delta + list.length) % list.length
    const next = list[index]
    if (!next) return
    void jump(next)
  }

  function blurTypingTarget() {
    const active = document.activeElement
    if (active instanceof HTMLElement && isTypingTarget(active)) active.blur()
  }

  function setKeyboardFocus(pane: "left" | "middle" | "right") {
    batch(() => {
      setState("focusPane", pane)
      setState("focusVisible", true)
    })
  }

  function clearKeyboardFocus(pane?: "left" | "middle" | "right") {
    batch(() => {
      if (pane) setState("focusPane", pane)
      setState("focusVisible", false)
    })
  }

  function handleConfigKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return
    if (event.metaKey || event.ctrlKey || event.altKey) return

    const key = event.key
    if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Enter") {
      return
    }

    // Allow Escape-style leave from right pane inputs via ArrowLeft only when caret is at start
    if (isTypingTarget(event.target)) {
      if (key === "ArrowLeft" && state.focusPane === "right") {
        const target = event.target
        if (
          (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
          target.selectionStart === 0 &&
          target.selectionEnd === 0
        ) {
          event.preventDefault()
          target.blur()
          setKeyboardFocus("middle")
        }
      }
      return
    }

    if (key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault()
      const delta = key === "ArrowDown" ? 1 : -1
      if (state.focusPane === "left") {
        setKeyboardFocus("left")
        moveLeft(delta)
      } else if (state.focusPane === "middle") {
        setKeyboardFocus("middle")
        moveMiddle(delta)
      } else {
        setKeyboardFocus("right")
      }
      return
    }

    if (key === "ArrowLeft") {
      event.preventDefault()
      if (state.focusPane === "right") {
        blurTypingTarget()
        setKeyboardFocus("middle")
        return
      }
      if (state.focusPane === "middle") {
        setKeyboardFocus("left")
      } else {
        setKeyboardFocus("left")
      }
      return
    }

    if (key === "ArrowRight" || key === "Enter") {
      if (state.focusPane === "right") return
      event.preventDefault()
      if (state.focusPane === "left") {
        const list = picks(state.section)
        if (list.length === 0) {
          if (state.section === "claws") setKeyboardFocus("right")
          else setKeyboardFocus("left")
          return
        }
        if (!list.includes(state.pick)) selectMiddlePick(list[0] ?? "")
        setKeyboardFocus("middle")
        return
      }
      if (state.focusPane === "middle") {
        setKeyboardFocus("right")
      }
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleConfigKeyDown)
    onCleanup(() => window.removeEventListener("keydown", handleConfigKeyDown))
  })

  function selectClaw(id: string) {
    batch(() => {
      setState("section", "claws")
      setState("pick", id)
      setState({ doc: "", text: "", saved: "", busy: false })
    })
  }

  createEffect(
    on(
      () => [
        state.section,
        state.skillPanel,
        agentsMd().length,
        providerVisible().length,
        agents().length,
        claws().length,
        skillDocs().length,
        commandDocs().length,
        plugins()?.length ?? 0,
      ],
      () => {
        if (!state.section) return
        if (state.section === "skills" && state.skillPanel === "market") return
        if (state.section === "claws") return
        const list = picks(state.section)
        if (list.includes(state.pick)) return
        if (list.length === 0 && (agentWait() || skillWait() || pluginWait())) {
          setState("pick", "")
          return
        }
        const next = list[0] ?? ""
        setState("pick", next)
        const item = docs().get(next)
        if (!item) {
          setState({ doc: "", text: "", saved: "", busy: false })
          return
        }
        void open(item)
      },
    ),
  )

  createEffect(
    on(
      () => selectedCustom()?.id,
      (id) => {
        if (!id) return
        if (state.customID === id) return
        const cfgItem = cfg().provider?.[id] as ProviderCfg | undefined
        const next = providerCfg(cfgItem)
        next.providerID = id
        if (cfgItem?.npm) next.npm = cfgItem.npm
        if (!next.apiKey) {
          const provider = selectedCustom()
          if (provider?.key) next.apiKey = provider.key
          else if (provider?.env?.[0]) next.apiKey = `{env:${provider.env[0]}}`
        }
        setState("customID", id)
        setState("customApiDirty", false)
        setState("custom", next)
        setState("custom", "secret", true)
      },
    ),
  )

  async function open(item: DocItem) {
    const run = ++openRun
    if (item.id.startsWith("skill:")) setState("skillPanel", "editor")
    setState("pick", item.id)
    const cached = item.content ?? cache.get(item.path)
    if (cached !== undefined) {
      setState({ doc: item.id, busy: false, text: cached, saved: cached })
      return
    }
    const timeout = setTimeout(() => {
      if (openRun !== run) return
      setState("busy", true)
    }, 120)
    const text = await loadDoc(item)
    clearTimeout(timeout)
    if (openRun !== run || state.pick !== item.id) return
    setState({ doc: item.id, busy: false, text, saved: text })
  }

  async function save() {
    const item = currentDoc()
    if (!item?.editable || !platform.writeLocalFile) return
    await platform
      .writeLocalFile(item.path, state.text)
      .then(() => {
        cache.set(item.path, state.text)
        setState("saved", state.text)
        showToast({ title: t("common.save"), description: item.label })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }

  async function saveJsoncAgent(name: string, form: JsoncAgentForm) {
    console.info("[config] jsonc agent save started", { name })
    const files = await platform.listConfigFiles?.(null)
    const file = files?.find(
      (item) => item.scope === "global" && item.kind === "config" && item.label === "opencode.jsonc",
    )
    if (!file?.path || !platform.readLocalFile || !platform.writeLocalFile)
      throw new Error(t("config.error.globalConfigUnavailable"))
    console.info("[config] jsonc agent config file resolved", { name, path: file.path })

    const number = (label: string, value: string) => {
      if (!value.trim()) return undefined
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number.`)
      return parsed
    }
    const steps = number("Steps", form.steps)
    if (steps !== undefined && (!Number.isInteger(steps) || steps <= 0))
      throw new Error("Steps must be a positive integer.")

    const fields: Record<string, unknown> = {
      model: form.model.trim() || undefined,
      variant: form.variant.trim() || undefined,
      temperature: number("Temperature", form.temperature),
      top_p: number("Top P", form.topP),
      description: form.description.trim() || undefined,
      prompt: form.prompt.trim() || undefined,
      mode: form.mode || undefined,
      hidden: form.hidden || undefined,
      disable: form.disable || undefined,
      color: form.color.trim() || undefined,
      steps,
      permission: jsoncObjectField("Permission", form.permission),
      options: jsoncObjectField("Options", form.options),
    }
    let text = (await platform.readLocalFile(file.path)) ?? "{}"
    console.info("[config] jsonc agent config file read", { name, path: file.path, bytes: text.length })
    for (const [key, value] of Object.entries(fields)) text = patchText(text, ["agent", name, key], value)
    await platform.writeLocalFile(file.path, text)
    console.info("[config] jsonc agent config file written", { name, path: file.path, bytes: text.length })
    setConfigFileAgents(configuredAgentsFromJsonc(text))
    await refreshAfterConfigWrite({
      source: `jsonc-agent:${name}`,
      refreshConfig: () => globalSync.refreshConfig(mainDomain),
      refresh: () => bump("agentRev"),
    })
    console.info("[config] jsonc agent save completed", { name })
    showToast({ variant: "success", title: t("common.save"), description: name })
  }

  function validateClaw(required = state.claw.enabled) {
    const url = state.claw.url.trim()
    const err = required && !url ? t("config.claws.error.urlRequired") : ""
    setState("claw", "err", "url", err)
    return !err
  }

  function clawInput(): OpenclawConfig {
    return {
      enabled: state.claw.enabled,
      url: state.claw.url.trim() || undefined,
      token: state.claw.token.trim() || undefined,
    }
  }

  async function saveClaw() {
    if (!platform.setOpenclawConfig) return
    if (!validateClaw()) return
    setState("claw", "saving", true)
    setState("claw", "test", undefined)
    if (server.current?.integration === "openclaw" && !state.claw.enabled) {
      const key = server.lastNonExtraAgent
      if (key) {
        server.setActive(key)
      }
    }
    await Promise.resolve(platform.setOpenclawConfig(clawInput()))
      .then(async () => {
        bump("clawRev")
        showToast({ variant: "success", title: t("common.save"), description: selectedClaw()?.label ?? "OpenClaw" })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setState("claw", "saving", false))
  }

  async function testClaw() {
    if (!platform.testOpenclawConfig) return
    if (!validateClaw(true)) return
    const run = state.claw.run + 1
    setState("claw", "run", run)
    setState("claw", "testing", true)
    setState("claw", "test", undefined)
    await platform
      .testOpenclawConfig(clawInput())
      .then((item) => {
        if (state.claw.run !== run) return
        setState("claw", "test", { ok: item.ok, logs: item.logs })
        showToast({
          variant: item.ok ? "success" : "error",
          icon: item.ok ? "circle-check" : undefined,
          title: t("config.claws.action.test"),
          description: item.ok
            ? t("config.claws.test.success")
            : (item.logs[item.logs.length - 1] ?? t("common.requestFailed")),
        })
      })
      .catch((err: unknown) => {
        if (state.claw.run !== run) return
        const message = err instanceof Error ? err.message : String(err)
        setState("claw", "test", { ok: false, logs: [message] })
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => {
        if (state.claw.run !== run) return
        setState("claw", "testing", false)
      })
  }

  async function detectClaw() {
    if (!platform.detectOpenclawConfig) return
    setState("claw", "detecting", true)
    setState("claw", "test", undefined)
    await platform
      .detectOpenclawConfig()
      .then((item) => {
        const config = item.config
        if (!item.ok || !config?.url) {
          setState("claw", "test", { ok: false, logs: item.logs })
          showToast({
            title: t("config.claws.detect.failed"),
            description: item.logs[item.logs.length - 1] ?? t("common.requestFailed"),
          })
          return
        }
        batch(() => {
          setState("claw", "enabled", config.enabled ?? true)
          setState("claw", "url", config.url ?? "")
          setState("claw", "token", config.token ?? "")
          setState("claw", "err", "url", "")
          setState("claw", "test", { ok: true, logs: item.logs })
        })
        showToast({
          variant: "success",
          icon: "circle-check",
          title: t("config.claws.action.detect"),
          description: item.source
            ? t("config.claws.detect.successSource", { source: item.source })
            : t("config.claws.detect.success"),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes("No handler registered for 'detect-openclaw-config'")) {
          const url = "ws://127.0.0.1:18789"
          batch(() => {
            setState("claw", "enabled", true)
            setState("claw", "url", url)
            setState("claw", "err", "url", "")
            setState("claw", "test", {
              ok: true,
              logs: [
                "Desktop main process has not registered detect-openclaw-config yet.",
                `Using default OpenClaw gateway candidate ${url}.`,
                "Restart the desktop app to enable full auto-detection from environment variables and config files.",
              ],
            })
          })
          showToast({
            variant: "success",
            icon: "circle-check",
            title: t("config.claws.action.detect"),
            description: t("config.claws.detect.fallbackRestart"),
          })
          return
        }
        setState("claw", "test", { ok: false, logs: [message] })
        showToast({ title: t("config.claws.detect.failed"), description: message })
      })
      .finally(() => setState("claw", "detecting", false))
  }

  async function abortClaw() {
    setState("claw", "run", (value) => value + 1)
    setState("claw", "testing", false)
    setState("claw", "test", {
      ok: false,
      logs: ["Starting OpenClaw connection test", "Test aborted by user"],
    })
    await platform.abortOpenclawTest?.().catch(() => false)
  }

  function setClaw(key: "enabled" | "url" | "token", value: string | boolean) {
    setState("claw", key, value)
    if (key === "url") setState("claw", "err", "url", "")
    setState("claw", "test", undefined)
  }

  function validateGa(required = state.ga.enabled) {
    const dir = state.ga.genericAgentDir.trim()
    const err = required && !dir ? t("config.claws.error.gaDirRequired") : ""
    setState("ga", "err", "genericAgentDir", err)
    return !err
  }

  function gaInput(): GenericagentConfig {
    return {
      enabled: state.ga.enabled,
      pythonExecutable: state.ga.pythonExecutable.trim() || undefined,
      genericAgentDir: state.ga.genericAgentDir.trim() || undefined,
    }
  }

  async function saveGa() {
    if (!platform.setGenericagentConfig) return
    if (!validateGa()) return
    setState("ga", "saving", true)
    setState("ga", "test", undefined)
    if (server.current?.integration === "genericagent" && !state.ga.enabled) {
      const key = server.lastNonExtraAgent
      if (key) {
        server.setActive(key)
      }
    }
    await Promise.resolve(platform.setGenericagentConfig(gaInput()))
      .then(async () => {
        bump("gaRev")
        showToast({ variant: "success", title: t("common.save"), description: "GenericAgent" })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setState("ga", "saving", false))
  }

  async function testGa() {
    if (!platform.testGenericagentConfig) return
    if (!validateGa(true)) return
    const run = state.ga.run + 1
    setState("ga", "run", run)
    setState("ga", "testing", true)
    setState("ga", "test", undefined)
    await platform
      .testGenericagentConfig(gaInput())
      .then((item) => {
        if (state.ga.run !== run) return
        setState("ga", "test", { ok: item.ok, logs: item.logs })
        showToast({
          variant: item.ok ? "success" : "error",
          icon: item.ok ? "circle-check" : undefined,
          title: t("config.claws.action.test"),
          description: item.ok
            ? t("config.claws.test.success")
            : (item.logs[item.logs.length - 1] ?? t("common.requestFailed")),
        })
      })
      .catch((err: unknown) => {
        if (state.ga.run !== run) return
        const message = err instanceof Error ? err.message : String(err)
        setState("ga", "test", { ok: false, logs: [message] })
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => {
        if (state.ga.run !== run) return
        setState("ga", "testing", false)
      })
  }

  async function abortGa() {
    setState("ga", "run", (value) => value + 1)
    setState("ga", "testing", false)
    setState("ga", "test", {
      ok: false,
      logs: ["Starting GenericAgent connection test", "Test aborted by user"],
    })
    await platform.abortGenericagentTest?.().catch(() => false)
  }

  function setGa(key: "enabled" | "pythonExecutable" | "genericAgentDir", value: string | boolean) {
    setState("ga", key, value)
    if (key === "genericAgentDir") setState("ga", "err", "genericAgentDir", "")
    setState("ga", "test", undefined)
  }

  function chooseGenericAgentDir() {
    dialog.show(() => (
      <DialogSelectDirectory
        title={t("config.claws.field.genericAgentDir")}
        domain={mainDomain}
        onSelect={(value) => {
          if (typeof value !== "string") return
          setGa("genericAgentDir", value)
        }}
      />
    ))
  }

  function validateHm(required = state.hm.enabled) {
    const dir = state.hm.hermesDir.trim()
    const err = required && !dir ? t("config.claws.error.hermesDirRequired") : ""
    setState("hm", "err", "hermesDir", err)
    return !err
  }

  function hmInput(): HermesConfig {
    return {
      enabled: state.hm.enabled,
      pythonExecutable: state.hm.pythonExecutable.trim() || undefined,
      hermesDir: state.hm.hermesDir.trim() || undefined,
      hermesHome: state.hm.hermesHome.trim() || undefined,
    }
  }

  async function saveHm() {
    if (!platform.setHermesConfig) return
    if (!validateHm()) return
    const cfg = hmInput()
    console.debug("[config] save hermes", {
      enabled: cfg.enabled,
      python: cfg.pythonExecutable ?? null,
      dir: cfg.hermesDir ?? null,
      home: cfg.hermesHome ?? null,
    })
    setState("hm", "saving", true)
    setState("hm", "test", undefined)
    if (server.current?.integration === "hermes" && !state.hm.enabled) {
      const key = server.lastNonExtraAgent
      if (key) {
        server.setActive(key)
      }
    }
    await Promise.resolve(platform.setHermesConfig(cfg))
      .then(async () => {
        console.debug("[config] save hermes ok")
        bump("hmRev")
        showToast({ variant: "success", title: t("common.save"), description: "Hermes" })
      })
      .catch((err: unknown) => {
        console.debug("[config] save hermes failed", { err })
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setState("hm", "saving", false))
  }

  async function testHm() {
    if (!platform.testHermesConfig) return
    if (!validateHm(true)) return
    const cfg = hmInput()
    console.debug("[config] test hermes", {
      enabled: cfg.enabled,
      python: cfg.pythonExecutable ?? null,
      dir: cfg.hermesDir ?? null,
      home: cfg.hermesHome ?? null,
    })
    const run = state.hm.run + 1
    setState("hm", "run", run)
    setState("hm", "testing", true)
    setState("hm", "test", undefined)
    await platform
      .testHermesConfig(cfg)
      .then((item) => {
        if (state.hm.run !== run) return
        console.debug("[config] test hermes done", { ok: item.ok, logs: item.logs.length })
        setState("hm", "test", { ok: item.ok, logs: item.logs })
        showToast({
          variant: item.ok ? "success" : "error",
          icon: item.ok ? "circle-check" : undefined,
          title: t("config.claws.action.test"),
          description: item.ok
            ? t("config.claws.test.success")
            : (item.logs[item.logs.length - 1] ?? t("common.requestFailed")),
        })
      })
      .catch((err: unknown) => {
        if (state.hm.run !== run) return
        console.debug("[config] test hermes failed", { err })
        const message = err instanceof Error ? err.message : String(err)
        setState("hm", "test", { ok: false, logs: [message] })
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => {
        if (state.hm.run !== run) return
        setState("hm", "testing", false)
      })
  }

  async function abortHm() {
    console.debug("[config] abort hermes test")
    setState("hm", "run", (value) => value + 1)
    setState("hm", "testing", false)
    setState("hm", "test", {
      ok: false,
      logs: ["Starting Hermes connection test", "Test aborted by user"],
    })
    await platform.abortHermesTest?.().catch(() => false)
  }

  function setHm(key: "enabled" | "pythonExecutable" | "hermesDir" | "hermesHome", value: string | boolean) {
    setState("hm", key, value)
    if (key === "hermesDir") setState("hm", "err", "hermesDir", "")
    setState("hm", "test", undefined)
  }

  function cliAgentInput(id: CliAgentID): CliAgentConfig {
    const form = state.cliAgents[id] ?? cliAgentCfg()
    return {
      enabled: form.enabled,
      binaryPath: form.binaryPath.trim() || undefined,
      configHome: form.configHome.trim() || undefined,
    }
  }

  function setCliAgent(
    id: CliAgentID,
    key: "enabled" | "binaryPath" | "configHome" | "provider" | "model" | "baseURL" | "apiKey" | "clearApiKey",
    value: string | boolean,
  ) {
    if (!state.cliAgents[id]) setState("cliAgents", id, cliAgentCfg())
    setState("cliAgents", id, key, value)
    if (key === "apiKey" && typeof value === "string" && value.trim()) {
      setState("cliAgents", id, "clearApiKey", false)
    }
    if (key === "clearApiKey" && value === true) {
      setState("cliAgents", id, "apiKey", "")
    }
    setState("cliAgents", id, "test", undefined)
  }

  async function refreshCliAgentInfo(id: CliAgentID) {
    if (!platform.cliAgents) return
    const run = (cliAgentInfoRuns[id] ?? 0) + 1
    cliAgentInfoRuns[id] = run
    setCliAgentLoading(id, "info", true)
    try {
      const info = await platform.cliAgents.info(id, cliAgentInput(id))
      if (run !== cliAgentInfoRuns[id]) return
      setCliAgentInfo(id, info)
      if (id === "dsh" && info.dsh) {
        setState("cliAgents", id, "provider", info.dsh.provider || "deepseek-official")
        setState("cliAgents", id, "model", info.dsh.model || "deepseek-v4-flash")
        setState("cliAgents", id, "baseURL", info.dsh.baseURL || "")
        setState("cliAgents", id, "hasFileApiKey", info.dsh.hasFileApiKey)
        setState("cliAgents", id, "apiKeyEnvSet", info.dsh.apiKeyEnvSet)
        setState("cliAgents", id, "baseUrlEnvSet", info.dsh.baseUrlEnvSet)
        setState("cliAgents", id, "clearApiKey", false)
        setState("cliAgents", id, "secret", true)
        if (platform.cliAgents.getDshApiKey) {
          const key = await platform.cliAgents.getDshApiKey(cliAgentInput(id)).catch(() => undefined)
          if (run !== cliAgentInfoRuns[id]) return
          setState("cliAgents", id, "apiKey", key ?? "")
        } else {
          setState("cliAgents", id, "apiKey", "")
        }
      }
    } catch (error) {
      if (run !== cliAgentInfoRuns[id]) return
      const message = error instanceof Error ? error.message : String(error)
      showToast({ title: language.t("common.requestFailed"), description: message })
    } finally {
      if (run === cliAgentInfoRuns[id]) setCliAgentLoading(id, "info", false)
    }
  }

  function toggleDshSecret() {
    if (!state.cliAgents.dsh) setState("cliAgents", "dsh", cliAgentCfg())
    setState("cliAgents", "dsh", "secret", (value) => !value)
  }

  async function copyDshApiKey() {
    const value = state.cliAgents.dsh?.apiKey?.trim()
    if (!value) return
    console.debug("[config] copy dsh api key")
    try {
      await navigator.clipboard.writeText(value)
      console.debug("[config] copied dsh api key")
      markCopied("dsh-api-key")
    } catch (error) {
      console.debug("[config] copy dsh api key failed", { error })
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function copyCustomApiKey() {
    const value = state.custom.apiKey?.trim()
    if (!value) return
    console.debug("[config] copy custom api key")
    try {
      await navigator.clipboard.writeText(value)
      console.debug("[config] copied custom api key")
      markCopied("custom-api-key")
    } catch (error) {
      console.debug("[config] copy custom api key failed", { error })
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function loadDshPlugins() {
    if (!platform.cliAgents?.listDshPlugins) return
    const run = ++dshPluginsRun
    setDshPlugins("loading", true)
    try {
      const inventory = await platform.cliAgents.listDshPlugins(cliAgentInput("dsh"), "headless")
      if (run !== dshPluginsRun) return
      setDshPlugins("inventory", inventory)
      setDshPlugins("expandedId", undefined)
      if (inventory.error) {
        showToast({ title: language.t("common.requestFailed"), description: inventory.error })
      }
    } catch (error) {
      if (run !== dshPluginsRun) return
      const message = error instanceof Error ? error.message : String(error)
      setDshPlugins("inventory", {
        profile: "headless",
        checkedAt: Date.now(),
        plugins: [],
        sources: [],
        error: message,
      })
      showToast({ title: language.t("common.requestFailed"), description: message })
    } finally {
      if (run === dshPluginsRun) setDshPlugins("loading", false)
    }
  }

  async function setDshPluginEnabled(id: string, enabled: boolean) {
    if (!platform.cliAgents?.setDshPluginEnabled) return
    setDshPlugins("togglingId", id)
    try {
      const inventory = await platform.cliAgents.setDshPluginEnabled(cliAgentInput("dsh"), {
        profile: dshPlugins.inventory?.profile || "headless",
        id,
        enabled,
      })
      setDshPlugins("inventory", inventory)
      if (inventory.error) {
        showToast({ title: language.t("common.requestFailed"), description: inventory.error })
        return
      }
      showToast({
        variant: "success",
        title: enabled
          ? language.t("config.claws.dsh.plugins.enabledToast")
          : language.t("config.claws.dsh.plugins.disabledToast"),
        description: id,
      })
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setDshPlugins("togglingId", undefined)
    }
  }

  async function saveCliAgent(id: CliAgentID) {
    if (!platform.cliAgents) return
    const form = state.cliAgents[id]
    if (!form) return
    const descriptor = cliAgentDescriptors().find((agent) => agent.id === id)
    const config = cliAgentInput(id)
    setState("cliAgents", id, "saving", true)
    setState("cliAgents", id, "test", undefined)
    try {
      await platform.cliAgents.set(id, config)
      setCliAgentConfigs(id, config)
      if (id === "dsh" && platform.cliAgents.setDshHome) {
        await platform.cliAgents.setDshHome(config, {
          provider: form.provider.trim() || "deepseek-official",
          model: form.model.trim() || "deepseek-v4-flash",
          baseURL: form.baseURL.trim(),
          apiKey: form.apiKey.trim() || undefined,
          clearApiKey: form.clearApiKey || undefined,
        })
        setState("cliAgents", id, "apiKey", "")
        setState("cliAgents", id, "clearApiKey", false)
      }
      showToast({ variant: "success", title: t("common.save"), description: descriptor?.label ?? id })
      await refreshCliAgentInfo(id)
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setState("cliAgents", id, "saving", false)
    }
  }

  async function testCliAgent(id: CliAgentID) {
    if (!platform.cliAgents) return
    const form = state.cliAgents[id]
    if (!form) return
    const config = cliAgentInput(id)
    const run = form.run + 1
    setState("cliAgents", id, "run", run)
    setState("cliAgents", id, "testing", true)
    setState("cliAgents", id, "test", undefined)
    try {
      const result = await platform.cliAgents.test(id, config)
      if (state.cliAgents[id]?.run !== run) return
      setState("cliAgents", id, "test", result)
      void refreshCliAgentInfo(id)
      showToast({
        variant: result.ok ? "success" : "error",
        icon: result.ok ? "circle-check" : undefined,
        title: t("config.claws.action.test"),
        description: result.ok ? t("config.claws.test.success") : (result.logs.at(-1) ?? t("common.requestFailed")),
      })
    } catch (error) {
      if (state.cliAgents[id]?.run !== run) return
      const message = error instanceof Error ? error.message : String(error)
      setState("cliAgents", id, "test", { ok: false, logs: [message] })
      showToast({ title: language.t("common.requestFailed"), description: message })
    } finally {
      if (state.cliAgents[id]?.run === run) setState("cliAgents", id, "testing", false)
    }
  }

  function chooseHermesDir() {
    dialog.show(() => (
      <DialogSelectDirectory
        title={t("config.claws.field.hermesDir")}
        domain={mainDomain}
        onSelect={(value) => {
          if (typeof value !== "string") return
          setHm("hermesDir", value)
        }}
      />
    ))
  }

  function openFolder() {
    const item = currentDoc()
    if (!item || !platform.openInFinder) return
    void platform.openInFinder(dir(item.path))
  }

  function copyPath() {
    const item = currentDoc()
    if (!item?.path) return
    console.debug(`[config] copy path path=${item.path}`)
    void navigator.clipboard.writeText(item.path).then(
      () => {
        console.debug(`[config] copied path path=${item.path}`)
        markCopied("config-path")
      },
      (err: unknown) => {
        console.debug(
          `[config] copy path failed path=${item.path} err=${err instanceof Error ? err.message : String(err)}`,
        )
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      },
    )
  }

  const setConfig = (next: Config) => globalSync.set("config", next)

  async function patchConfig(patch: Partial<Config>, options?: { refreshProviders?: boolean }) {
    const next = { ...cfg(), ...patch }
    await globalSync.updateConfig(patch as Config, options)
    setConfig(next)
    return next
  }

  async function update(next: Partial<Config>, options?: { refreshProviders?: boolean }) {
    await patchConfig(next, options).catch((err: unknown) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    })
  }

  function refreshProviderStateInBackground() {
    void globalSync.provider.refresh(mainDomain).catch((err: unknown) => {
      console.error(`[config] provider refresh failed error=${err instanceof Error ? err.message : String(err)}`)
    })
  }

  function refreshProviderState() {
    return globalSync.provider.refresh(mainDomain)
  }

  function setCustomField(key: "providerID" | "npm" | "name" | "baseURL" | "apiKey", value: string) {
    setState("custom", key, value)
    if (key === "apiKey") setState("customApiDirty", true)
    if (key === "providerID" || key === "name" || key === "baseURL") setState("custom", "err", key, undefined)
  }

  function setCustomModel(index: number, key: "id" | "name", value: string) {
    setState("custom", "models", index, key, value)
    setState("custom", "models", index, "err", key, undefined)
  }

  function setCustomModelConfig(modelIndex: number, configIndex: number, value: string) {
    const key = state.custom.models[modelIndex]?.config[configIndex]?.key
    setState("custom", "models", modelIndex, "config", configIndex, "value", value)
    if (key) setState("custom", "models", modelIndex, "err", "config", key, undefined)
  }

  function toggleCustomModelConfig(index: number) {
    setState("custom", "models", index, "expanded", (value) => !value)
  }

  function setCustomHeader(index: number, key: "key" | "value", value: string) {
    setState("custom", "headers", index, key, value)
    setState("custom", "headers", index, "err", key, undefined)
  }

  function addCustomModel() {
    setState("custom", "models", (rows) => [...rows, blankModelRow()])
  }

  function addFetchedCustomModel(id: string, name: string) {
    setState("custom", "models", (rows) => {
      if (rows.length === 1 && !rows[0].id.trim() && !rows[0].name.trim()) {
        return [{ ...rows[0], id, name }]
      }
      return [...rows, { ...blankModelRow(), id, name }]
    })
  }

  function removeCustomModel(index: number) {
    if (state.custom.models.length <= 1) return
    setState("custom", "models", (rows) => rows.filter((_, idx) => idx !== index))
  }

  function addCustomHeader() {
    setState("custom", "headers", (rows) => [...rows, blankHeaderRow()])
  }

  function removeCustomHeader(index: number) {
    if (state.custom.headers.length <= 1) return
    setState("custom", "headers", (rows) => rows.filter((_, idx) => idx !== index))
  }

  function createCustomProvider() {
    setState("pick", CUSTOM_NEW)
    setState("customID", "")
    setState("customApiDirty", false)
    setState("custom", providerCfg(undefined))
  }

  const [refreshing, setRefreshing] = createSignal(false)

  const refreshProviders = async () => {
    if (refreshing()) return
    setRefreshing(true)
    try {
      console.info("[config] provider refresh started")
      const config = await globalSync.refreshConfig(mainDomain)
      console.info("[config] provider runtime config refreshed", { agentCount: Object.keys(config.agent ?? {}).length })
      const directory = globalSync.data.path.directory
      const client = directory
        ? globalSDK.forDomain(mainDomain).createClient({ directory })
        : globalSDK.forDomain(mainDomain).client
      const result = await client.provider.list()
      const data = result.data
      if (!data) throw new Error(t("common.requestFailed"))
      setMainProviders(normalizeProviderList(data))
      console.info("[config] provider list refreshed", { providerCount: data.all.length })
      showToast({
        variant: "success",
        icon: "circle-check",
        title: t("settings.providers.refreshed.title"),
        description: t("settings.providers.refreshed.description"),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("[config] provider refresh failed", { message })
      showToast({ title: t("common.requestFailed"), description: message })
    } finally {
      console.info("[config] provider refresh finished")
      setRefreshing(false)
    }
  }

  function commandTemplate(title: string) {
    const cmdName = title.trim()
    return [
      "---",
      `description: "${cmdName ? "Describe this command" : "New command"}"`,
      "---",
      "",
      cmdName ? `# /${cmdName}` : "# New Command",
      "",
      "Add the command template here.",
      "",
    ].join("\n")
  }

  function createCommand(projectRoot = "", projectLabel = "") {
    const text = commandTemplate("")
    setState("pick", COMMAND_NEW)
    setState("doc", COMMAND_NEW)
    setState("text", text)
    setState("saved", text)
    setState("busy", false)
    setState("cmdTitle", "")
    setState("cmdErr", "")
    setState("cmdPath", "")
    setState("cmdCreateDir", projectRoot ? join(projectRoot, ".opencode", "commands") : "")
    setState("cmdCreateProjectRoot", projectRoot)
    setState("cmdCreateProjectLabel", projectLabel)
    setState("cmdSaving", false)
  }

  function setCommandTitle(value: string) {
    const prev = state.cmdTitle
    setState("cmdTitle", value)
    setState("cmdErr", "")
    if (state.text !== commandTemplate(prev)) return
    const text = commandTemplate(value)
    setState("text", text)
    setState("saved", text)
  }

  async function saveCommand() {
    const targetDir = state.cmdCreateDir || (space()?.configRoot ? join(space()!.configRoot!, "commands") : "")
    if (!targetDir || !platform.createLocalFile) return
    const title = state.cmdTitle.trim()
    if (!title) {
      setState("cmdErr", t("config.commands.error.nameRequired"))
      return
    }
    const safeName = commandSafeName(title)
    if (!safeName) {
      setState("cmdErr", t("config.commands.error.nameRequired"))
      return
    }
    const path = join(targetDir, safeName + ".md")
    const isProject = !!state.cmdCreateProjectRoot
    setState("cmdSaving", true)
    try {
      await platform.createLocalFile(path, state.text)
      cache.set(path, state.text)
      batch(() => {
        setState("cmdPath", path)
        setState("doc", `cmd:${path}`)
        setState("pick", `cmd:${path}`)
        setState("saved", state.text)
        setState("busy", false)
      })
      bump("commandRev")
      await open({
        id: `cmd:${path}`,
        label: safeName,
        path,
        editable: true,
        source: isProject ? "project" : "global",
        group: isProject ? "project" : "global",
        root: isProject ? state.cmdCreateProjectRoot : space()?.configRoot,
        project: isProject ? state.cmdCreateProjectLabel : undefined,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: "Failed", description: message })
    } finally {
      setState("cmdSaving", false)
    }
  }

  async function deleteCommand(item?: DocItem) {
    if (!item?.path || !platform.deleteLocalFile) return
    await platform
      .deleteLocalFile(item.path)
      .then(() => {
        cache.delete(item.path)
        batch(() => {
          setState("pick", "")
          setState("doc", "")
          setState("text", "")
          setState("saved", "")
          setState("cmdPath", "")
        })
        bump("commandRev")
        showToast({ variant: "success", title: t("config.action.delete"), description: item.label })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }

  function cancelCommandCreate() {
    const text = commandTemplate("")
    batch(() => {
      setState("pick", "")
      setState("doc", "")
      setState("text", text)
      setState("saved", text)
      setState("cmdTitle", "")
      setState("cmdErr", "")
      setState("cmdPath", "")
      setState("cmdCreateDir", "")
      setState("cmdCreateProjectRoot", "")
      setState("cmdCreateProjectLabel", "")
      setState("cmdSaving", false)
      setState("busy", false)
    })
  }

  function createSkill(projectRoot = "", projectLabel = "") {
    const text = skillTemplate("")
    setState("skillPanel", "editor")
    setState("pick", SKILL_NEW)
    setState("doc", SKILL_NEW)
    setState("text", text)
    setState("saved", text)
    setState("busy", false)
    setState("skillTitle", "")
    setState("skillErr", "")
    setState("skillPath", "")
    setState("skillNote", "")
    setState("skillWarn", "")
    setState("skillCreateRoot", projectRoot ? join(projectRoot, ".opencode", "skills") : "")
    setState("skillCreateProjectRoot", projectRoot)
    setState("skillCreateProjectLabel", projectLabel)
    setState("skillSaving", false)
  }

  function openSkillMarket() {
    batch(() => {
      setState("skillPanel", "market")
      setState("busy", false)
    })
  }

  function selectSkillMarketRepo(id: string) {
    setState("skillMarketRepo", id)
  }

  function setSkillTitle(value: string) {
    const prev = state.skillTitle
    setState("skillTitle", value)
    setState("skillErr", "")
    if (state.text !== skillTemplate(prev)) return
    const text = skillTemplate(value)
    setState("text", text)
    setState("saved", text)
  }

  function validateSkillTitle() {
    const title = state.skillTitle.trim()
    if (!title) return t("config.skills.create.error.required")
    if (title === "." || title === "..") return t("config.skills.create.error.reserved")
    if (/[/\\]/.test(title)) return t("config.skills.create.error.slash")
    return ""
  }

  async function saveSkill() {
    const root = state.skillCreateRoot || space()?.skillsRoot
    if (!root || !platform.createLocalFile) {
      setState("skillErr", t("config.error.globalConfigUnavailable"))
      return
    }
    const err = validateSkillTitle()
    if (err) {
      setState("skillErr", err)
      return
    }
    const title = state.skillTitle.trim()
    const path = join(root, title, "SKILL.md")
    const text = state.text
    const isProject = !!state.skillCreateProjectRoot
    setState("skillSaving", true)
    await platform
      .createLocalFile(path, text)
      .then(async () => {
        const meta = skillMeta(text, path)
        cache.set(path, text)
        setState("skillPath", path)
        setState("skillNote", meta.description)
        setState("skillWarn", meta.warn ?? "")
        bump("skillRev")
        showToast({ variant: "success", title: t("common.save"), description: title })
        await open({
          id: `skill:${path}`,
          label: meta.name,
          path,
          editable: true,
          source: isProject ? "project" : "opencode",
          note: meta.description,
          warn: meta.warn,
          group: isProject ? "project" : "opencode",
          root: isProject ? state.skillCreateProjectRoot : undefined,
          project: isProject ? state.skillCreateProjectLabel : undefined,
        })
      })
      .catch((err: unknown) => {
        setState("skillErr", err instanceof Error ? err.message : String(err))
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setState("skillSaving", false))
  }

  function cancelSkillCreate() {
    const text = skillTemplate("")
    batch(() => {
      setState("pick", "")
      setState("doc", "")
      setState("text", text)
      setState("saved", text)
      setState("skillTitle", "")
      setState("skillErr", "")
      setState("skillPath", "")
      setState("skillNote", "")
      setState("skillWarn", "")
      setState("skillCreateRoot", "")
      setState("skillCreateProjectRoot", "")
      setState("skillCreateProjectLabel", "")
      setState("skillSaving", false)
      setState("busy", false)
    })
  }

  async function installMarketSkill(
    item: SkillMarketItem,
    scope: SkillMarketInstallScope,
    target?: SkillMarketProjectTarget,
  ) {
    const root = scope === "project" ? (target ? join(target.root, ".opencode", "skills") : "") : space()?.skillsRoot
    if (!root || !platform.createLocalFile) {
      showToast({ title: t("common.requestFailed"), description: t("config.error.globalConfigUnavailable") })
      return
    }
    const path = join(root, item.folder, "SKILL.md")
    const isProject = scope === "project"
    setState("skillMarketInstalling", `${scope}:${isProject ? `${target?.root ?? ""}:` : ""}${item.id}`)
    await platform
      .createLocalFile(path, item.content)
      .then(async () => {
        const meta = skillMeta(item.content, path)
        cache.set(path, item.content)
        bump("skillRev")
        showToast({
          variant: "success",
          title: t("config.skills.market.install.success"),
          description: meta.name,
        })
        await open({
          id: `skill:${path}`,
          label: meta.name,
          path,
          editable: true,
          source: isProject ? "project" : "opencode",
          note: meta.description,
          warn: meta.warn,
          group: isProject ? "project" : "opencode",
          root: isProject ? target?.root : undefined,
          project: isProject ? target?.label : undefined,
        })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setState("skillMarketInstalling", ""))
  }

  async function deleteSkill(item: DocItem) {
    if (!platform.renameLocalFile) return
    const bakPath = `${item.path}.bak`
    await platform
      .renameLocalFile(item.path, bakPath)
      .then(() => {
        cache.delete(item.path)
        if (state.pick === item.id) {
          batch(() => {
            setState("pick", "")
            setState("text", "")
            setState("saved", "")
          })
        }
        bump("skillRev")
        showToast({ variant: "success", title: t("config.action.delete"), description: item.label })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }

  function toggleCustomSecret() {
    setState("custom", "secret", (value) => !value)
  }

  function validateCustom() {
    const output = validateCustomProvider({
      form: state.custom,
      t: language.t,
      disabledProviders: cfg().disabled_providers ?? [],
      existingProviderIDs: new Set(providers().map((item) => item.id)),
      currentProviderID: state.custom.mode === "edit" ? state.customID : undefined,
    })
    setState("custom", "err", output.err)
    output.models.forEach((err, index) => setState("custom", "models", index, "err", err))
    output.headers.forEach((err, index) => setState("custom", "headers", index, "err", err))
    return output.result
  }

  async function saveCustom() {
    const result = validateCustom()
    if (!result) return
    setState("custom", "saving", true)
    const prev = state.custom.mode === "edit" ? state.customID : undefined
    const id = result.providerID
    const configuredKey = prev === id ? cfg().provider?.[id]?.options?.apiKey : undefined
    const initialKey =
      typeof configuredKey === "string"
        ? configuredKey
        : prev === id
          ? (selectedCustom()?.key ?? state.custom.apiKey)
          : ""
    const keyChanged = state.customApiDirty && result.key !== initialKey
    const nextEntry = result.config as ProviderCfg
    if (!nextEntry.options) nextEntry.options = {}
    nextEntry.options = {
      ...nextEntry.options,
      ...(result.key ? { apiKey: result.key } : {}),
    }
    if (!result.key && nextEntry.options) nextEntry.options.apiKey = ""
    const currentDisabled = cfg().disabled_providers ?? []
    const nextDisabled = currentDisabled.filter((item) => item !== id && item !== prev)
    let declared: ProviderCfg | undefined
    if (prev === id) {
      try {
        if (!platform.listConfigFiles || !platform.readLocalFile)
          throw new Error(t("config.error.globalConfigUnavailable"))
        const files = (await platform.listConfigFiles(null)).filter(
          (file) => file.scope === "global" && file.kind === "config",
        )
        const records = await Promise.all(
          files.map(async (file) => ({
            file,
            text: file.exists ? ((await platform.readLocalFile!(file.path)) ?? "{}") : "{}",
          })),
        )
        declared = declaredProviderEntry(records, id) as ProviderCfg | undefined
        if (!declared) throw new Error(`No global config declares provider ${id}.`)
      } catch (err) {
        console.info(`[config] custom provider save blocked provider=${id} reason=raw-config-unavailable`)
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
        setState("custom", "saving", false)
        return
      }
    }
    const changed = changedProviderEntry(
      prev === id ? cfg().provider?.[id] : undefined,
      nextEntry,
      keyChanged,
      declared,
    )
    const nextProvider = {
      ...(prev && prev !== id ? { [prev]: {} as ProviderCfg } : {}),
      ...(changed ? { [id]: changed } : {}),
    } as NonNullable<Config["provider"]>
    const patch = globalProviderPatch(
      nextProvider,
      JSON.stringify(currentDisabled) === JSON.stringify(nextDisabled) ? undefined : nextDisabled,
    )
    const previousModels = Object.keys(cfg().provider?.[prev ?? id]?.models ?? {})
    const nextModels = Object.keys(nextEntry.models ?? {})
    console.info("[config] custom provider save payload", {
      providerID: id,
      previousModelCount: previousModels.length,
      nextModelCount: nextModels.length,
      removedModels: previousModels.filter((modelID) => !nextModels.includes(modelID)),
    })
    await Promise.resolve()
      .then(() => {
        const fields = Object.keys(patch).sort().join(",") || "none"
        const providerFields = changed ? Object.keys(changed).sort().join(",") : "none"
        const providerOptionFields = changed?.options ? Object.keys(changed.options).sort().join(",") : "none"
        console.info(
          `[config] custom provider save fields=${fields} provider=${id} providerFields=${providerFields} optionFields=${providerOptionFields}`,
        )
        if (fields === "none") return globalSync.refreshConfig(mainDomain)
        return globalSync.updateConfig(patch, { refreshProviders: false })
      })
      .then(async (synced) => {
        const authRemovals = [
          ...(prev && prev !== id ? [prev] : []),
          ...(keyChanged ? [id] : []),
        ]
        await Promise.all(authRemovals.map((providerID) => globalSDK.client.auth.remove({ providerID })))
        batch(() => {
          setConfig(synced)
          if (prev && prev !== id) globalSync.provider.remove(prev)
          setState("pick", `provider:${id}`)
          setState("customID", id)
          setState("customApiDirty", false)
          setState("custom", "mode", "edit")
          setState("custom", "secret", true)
        })
        refreshProviderStateInBackground()
        showToast({ variant: "success", title: t("common.save"), description: id })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setState("custom", "saving", false))
  }

  async function deleteCustom() {
    const id = state.custom.mode === "edit" ? state.customID : state.custom.providerID.trim()
    if (!id) return
    setState("custom", "deleting", true)
    setState("providerBusy", id)
    const nextProvider = { [id]: {} as ProviderCfg } as NonNullable<Config["provider"]>
    const currentDisabled = cfg().disabled_providers ?? []
    const nextDisabled = currentDisabled.filter((item) => item !== id)
    const patch = globalProviderPatch(
      nextProvider,
      JSON.stringify(currentDisabled) === JSON.stringify(nextDisabled) ? undefined : nextDisabled,
    )
    console.info("[config] custom provider delete requested", {
      providerID: id,
      providerInConfig: id in (cfg().provider ?? {}),
      providerCount: Object.keys(cfg().provider ?? {}).length,
    })
    await globalSDK.client.auth
      .remove({ providerID: id })
      .then(() => console.info("[config] custom provider credentials removed", { providerID: id }))
      .catch((err: unknown) =>
        console.info("[config] custom provider credentials remove skipped", {
          providerID: id,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .then(() => {
        console.info(`[config] custom provider delete fields=provider,disabled_providers provider=${id}`)
        return globalSync.updateConfig(patch, { refreshProviders: false })
      })
      .then(async (synced) => {
        console.info("[config] custom provider config delete completed", {
          providerID: id,
          providerStillInConfig: id in (synced.provider ?? {}),
        })
        const persisted = await globalSync.refreshConfig(mainDomain)
        const providerStillInConfig = id in (persisted.provider ?? {})
        console.info("[config] custom provider delete persistence verified", {
          providerID: id,
          providerStillInConfig,
        })
        if (providerStillInConfig) {
          throw new Error(t("config.custom.deleteStillConfigured", { provider: id }))
        }
        await refreshProviderState()
        batch(() => {
          setConfig(persisted)
          globalSync.provider.remove(id)
          createCustomProvider()
        })
        showToast({ variant: "success", title: t("config.action.delete"), description: id })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        setState("custom", "deleting", false)
        if (state.providerBusy === id) setState("providerBusy", "")
      })
  }

  function isConfigCustom(id: string) {
    if (isBuiltinProvider(id)) return false
    const provider = cfg().provider?.[id]
    if (!provider) return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return typeof provider.npm === "string" && provider.npm.startsWith("@ai-sdk/")
  }

  function toggleProviderConfig(id: string, enabled: boolean) {
    const prev = cfg().disabled_providers ?? []
    const next = nextDisabledProviders(prev, id, enabled)
    console.log(`[config] toggle custom provider id=${id} enabled=${String(enabled)} disabled=${next.join(",")}`)
    return patchConfig({ disabled_providers: next }, { refreshProviders: false })
      .then(() => {
        if (!enabled) globalSync.provider.remove(id)
        refreshProviderStateInBackground()
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }

  async function disconnectProvider(item: ProviderItem) {
    if (item.source === "env") return
    if (isConfigCustom(item.id)) {
      await globalSDK.client.auth.remove({ providerID: item.id }).catch(() => undefined)
      const prev = cfg().disabled_providers ?? []
      const next = prev.includes(item.id) ? prev : [...prev, item.id]
      await patchConfig({ disabled_providers: next }, { refreshProviders: false })
      globalSync.provider.remove(item.id)
      await refreshProviderState()
      return
    }
    await globalSDK.client.auth.remove({ providerID: item.id })
    globalSync.provider.remove(item.id)
    await refreshProviderState()
  }

  function toggleBuiltinProvider(id: string, enabled: boolean) {
    const prev = cfg().disabled_providers ?? []
    const next = nextDisabledProviders(prev, id, enabled)
    console.log(`[config] toggle builtin provider id=${id} enabled=${String(enabled)} disabled=${next.join(",")}`)
    return patchConfig({ disabled_providers: next }, { refreshProviders: false })
      .then(async () => {
        console.log(`[config] builtin toggle refresh start id=${id} enabled=${String(enabled)}`)
        await refreshProviderState()
        console.log(`[config] builtin toggle refresh done id=${id}`)
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }

  async function signOutProvider(item: ProviderItem) {
    if (item.source === "env") return
    console.log(`[config] sign out start id=${item.id} source=${item.source ?? ""} allowed=${String(item.allowed)}`)
    const task = (async () => {
      await globalSDK.client.auth.remove({ providerID: item.id })
      globalSync.provider.remove(item.id)
      setMainProviders(stripProvider(mainProviders(), item.id))
      console.log(`[config] sign out removed from store id=${item.id}`)
      await refreshProviderState().catch((err: unknown) => {
        console.log(
          `[config] sign out refresh failed id=${item.id} error=${err instanceof Error ? err.message : String(err)}`,
        )
      })
      const after = mainProviders()
      const stillConnected = (after.connected ?? []).includes(item.id)
      console.log(
        `[config] sign out done id=${item.id} stillConnected=${String(stillConnected)} connectedCount=${String((after.connected ?? []).length)}`,
      )
    })()
    showPromiseToast(task, {
      loading: language.t("provider.disconnect.toast.removing", { provider: item.name }),
      success: () => language.t("provider.disconnect.toast.disconnected.description", { provider: item.name }),
      error: (err) => (err instanceof Error ? err.message : String(err)),
    })
    void task.finally(() => undefined).catch(() => undefined)
  }

  function toggleProvider(item: ProviderItem, enabled: boolean) {
    if (item.custom) {
      if (state.providerBusy === item.id) return
      setState("providerBusy", item.id)
      void toggleProviderConfig(item.id, enabled).finally(() => setState("providerBusy", ""))
      return
    }
    if (enabled) {
      if (!item.allowed) {
        if (state.providerBusy === item.id) return
        setState("providerBusy", item.id)
        void toggleBuiltinProvider(item.id, true).finally(() => setState("providerBusy", ""))
        return
      }
      dialog.show(() => <DialogConnectProvider provider={item.id} />)
      return
    }
    if (item.source === "env") return
    if (state.providerBusy === item.id) return
    setState("providerBusy", item.id)
    void toggleBuiltinProvider(item.id, false).finally(() => setState("providerBusy", ""))
  }

  async function toggleProjectPlugin(item: PluginItem, enabled: boolean) {
    if (!item.root || !platform.listConfigFiles || !platform.readLocalFile || !platform.writeLocalFile)
      throw new Error(t("config.error.globalConfigUnavailable"))

    const nextSpec = item.spec ?? (item.path ? spec(item.path) : item.name)
    const key = pluginKey(nextSpec)
    const files = (await platform.listConfigFiles(item.root)).filter(
      (file) => file.scope === "project" && file.kind === "config",
    )
    const records = await Promise.all(
      files.map(async (file) => ({
        file,
        text: file.exists ? ((await platform.readLocalFile!(file.path)) ?? "{}") : "{}",
      })),
    )
    const declared = records.find((record) => {
      const config = parse(record.text) as { plugin?: unknown }
      return (
        Array.isArray(config.plugin) &&
        config.plugin.some((entry) => {
          if (typeof entry !== "string" && !Array.isArray(entry)) return false
          return configPluginKey(entry as string | [string, Record<string, unknown>], record.file.path) === key
        })
      )
    })
    const target = declared ?? records.find((record) => record.file.label === ".opencode/opencode.jsonc")
    if (!target) throw new Error(`No project config file is available for ${item.label}.`)
    if (!enabled && !declared)
      throw new Error(`${item.label} is automatically discovered and cannot be disabled from config.`)

    const config = parse(target.text) as { plugin?: unknown }
    const next = updatePluginEntries({
      entries: config.plugin,
      configPath: target.file.path,
      key,
      nextSpecifier: item.path ? relativePluginSpecifier(item.path, target.file.path) : nextSpec,
      enabled,
    })
    await platform.writeLocalFile(target.file.path, patchText(target.text, ["plugin"], next))
    await globalSDK.client.instance.dispose({ directory: item.root }).catch(() => undefined)
    bump("pluginRev")
  }

  function togglePlugin(item: PluginItem, enabled: boolean) {
    if (item.group === "project") {
      void toggleProjectPlugin(item, enabled).catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      return
    }

    const prev = cfg().plugin ?? []
    const nextSpec = item.spec ?? (item.path ? spec(item.path) : item.name)
    const key = pluginKey(nextSpec)
    const keyOf = (entry: string | [string, Record<string, unknown>]) =>
      pluginKey(Array.isArray(entry) ? entry[0] : entry)
    const next = enabled
      ? Array.from(new Set([...prev.filter((entry) => keyOf(entry) !== key), nextSpec]))
      : prev.filter((entry) => keyOf(entry) !== key)
    void update({ plugin: next })
  }

  // NOTE: Config page is lazy-loaded. When changing sidebar text/font sizes,
  // middle column titles, or section descriptions here, also update
  // ConfigLoadingShell in app.tsx to avoid a visual flash on first render.
  return (
    <div class="size-full overflow-hidden bg-background-base">
      <div class="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_5%_0%,color-mix(in_srgb,var(--surface-brand-base)_7%,transparent),transparent_32%),linear-gradient(135deg,color-mix(in_srgb,var(--surface-brand-base)_3%,var(--background-base)),var(--background-base)_45%)] xl:flex-row">
        <aside
          class="shrink-0 border-b border-border-weak-base bg-[linear-gradient(165deg,color-mix(in_srgb,var(--surface-brand-base)_7%,var(--surface-base)),color-mix(in_srgb,var(--surface-brand-base)_3%,var(--background-base))_46%,var(--background-base))] transition-shadow duration-150 xl:w-[236px] xl:border-r xl:border-b-0"
          classList={{ [CONFIG_PANE_FOCUS_CLASS]: state.focusVisible && state.focusPane === "left" }}
          data-config-pane="left"
          data-focused={state.focusVisible && state.focusPane === "left" ? "true" : undefined}
          onMouseDown={() => clearKeyboardFocus("left")}
        >
          <div class="flex h-full min-h-0 flex-col">
            <div class="relative flex items-center gap-3 border-b border-border-weak-base px-4 py-5">
              <button
                type="button"
                class="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-weak-base bg-background-base/75 text-text-weak shadow-sm transition-[background-color,border-color,color,transform] hover:-translate-x-0.5 hover:border-border-strong hover:bg-background-base hover:text-text-strong active:translate-x-0"
                onClick={back}
                aria-label={language.t("common.goBack")}
              >
                <Icon name="chevron-left" size="small" />
              </button>
              <div class="min-w-0 text-20-medium text-text-strong">{t("config.title")}</div>
            </div>
            <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
              <div class="flex flex-col gap-1">
                <SectionButton
                  current={state.section === "providers"}
                  title={t("config.providers.title")}
                  description={t("config.nav.providersDescription")}
                  icon={sectionIcon("providers")}
                  onClick={() => void jump("providers")}
                />
                <SectionButton
                  current={state.section === "agents-md"}
                  title="AGENTS.md"
                  description={t("config.section.agentsMd")}
                  icon={sectionIcon("agents-md")}
                  onClick={() => void jump("agents-md")}
                />
                <SectionButton
                  current={state.section === "agents"}
                  title={t("config.agents.title")}
                  description={t("config.nav.agentsDescription")}
                  icon={sectionIcon("agents")}
                  onClick={() => void jump("agents")}
                />
                <SectionButton
                  current={state.section === "skills"}
                  title={t("config.skills.title")}
                  description={t("config.nav.skillsDescription")}
                  icon={sectionIcon("skills")}
                  onClick={() => void jump("skills")}
                />
                <SectionButton
                  current={state.section === "plugins"}
                  title={t("config.plugins.title")}
                  description={t("config.nav.pluginsDescription")}
                  icon={sectionIcon("plugins")}
                  onClick={() => void jump("plugins")}
                />
                <SectionButton
                  current={state.section === "mcp"}
                  title={t("config.mcp.title")}
                  description={t("config.nav.mcpDescription")}
                  icon={sectionIcon("mcp")}
                  onClick={() => void jump("mcp")}
                />
                <SectionButton
                  current={state.section === "commands"}
                  title={t("config.commands.title")}
                  description={t("config.nav.commandsDescription")}
                  icon={sectionIcon("commands")}
                  onClick={() => void jump("commands")}
                />
              </div>
              <div class="mx-2 my-3 h-px bg-[linear-gradient(90deg,var(--border-weak-base),transparent)]" />
              <div class="flex flex-col gap-1">
                <SectionButton
                  current={state.section === "channels"}
                  title={t("config.channels.title")}
                  description={t("config.nav.channelsDescription")}
                  icon={sectionIcon("channels")}
                  onClick={() => void jump("channels")}
                />
                {clawsSectionEnabled() && (
                  <SectionButton
                    current={state.section === "claws"}
                    title={t("config.claws.title")}
                    description={t("config.nav.clawsDescription")}
                    icon={sectionIcon("claws")}
                    onClick={() => void jump("claws")}
                  />
                )}
              </div>
            </div>
          </div>
        </aside>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col xl:flex-row">
          <section
            class="shrink-0 border-b border-border-weak-base bg-[color-mix(in_srgb,var(--surface-brand-base)_3%,var(--surface-base))] backdrop-blur transition-shadow duration-150 xl:w-[400px] xl:border-r xl:border-b-0"
            classList={{ [CONFIG_PANE_FOCUS_CLASS]: state.focusVisible && state.focusPane === "middle" }}
            data-config-pane="middle"
            data-focused={state.focusVisible && state.focusPane === "middle" ? "true" : undefined}
            onMouseDown={() => clearKeyboardFocus("middle")}
          >
            <div class="flex h-full min-h-0 flex-col">
              <div class="relative overflow-hidden bg-[linear-gradient(135deg,color-mix(in_srgb,var(--surface-brand-base)_8%,var(--background-base)),color-mix(in_srgb,var(--surface-brand-base)_3%,var(--background-base)))] px-5 py-5">
                <Switch>
                  <Match when={state.section === "agents-md"}>
                    <ConfigPaneTitle
                      title="AGENTS.md"
                      description={t("config.agentsMd.header")}
                      icon={sectionIcon("agents-md")}
                    />
                  </Match>
                  <Match when={state.section === "providers"}>
                    <ConfigPaneTitle
                      title={t("config.providers.title")}
                      description={t("config.providers.header")}
                      icon={sectionIcon("providers")}
                    />
                    <div class="mt-4 flex items-center gap-2">
                      <Button
                        size="large"
                        variant="ghost"
                        icon="plus-small"
                        class="border border-border-weak-base bg-background-base/75 shadow-none hover:border-border-base hover:bg-background-base"
                        onClick={createCustomProvider}
                      >
                        {t("config.custom.new")}
                      </Button>
                      <Button
                        size="large"
                        variant="ghost"
                        icon="arrow-sync"
                        class="border border-border-weak-base bg-background-base/75 shadow-none hover:border-border-base hover:bg-background-base"
                        disabled={refreshing()}
                        aria-label={t("settings.providers.refresh")}
                        onClick={() => void refreshProviders()}
                      >
                        {t("settings.providers.refresh")}
                      </Button>
                    </div>
                    <div class="mt-3">
                      <ConfigSearchBox
                        value={state.query}
                        placeholder={t("dialog.provider.search.placeholder")}
                        onInput={(value) => setState("query", value)}
                      />
                    </div>
                  </Match>
                  <Match when={state.section === "agents"}>
                    <ConfigPaneTitle
                      title={t("config.agents.title")}
                      description={t("config.agents.header")}
                      icon={sectionIcon("agents")}
                    />
                  </Match>
                  <Match when={state.section === "claws" && clawsSectionEnabled()}>
                    <ConfigPaneTitle
                      title={t("config.claws.title")}
                      description={t("config.claws.header")}
                      icon={sectionIcon("claws")}
                    />
                  </Match>
                  <Match when={state.section === "mcp"}>
                    <ConfigPaneTitle
                      title={t("config.mcp.title")}
                      description={t("config.mcp.header")}
                      icon={sectionIcon("mcp")}
                    />
                    <div class="mt-4 flex items-center gap-2">
                      <Button
                        size="small"
                        variant="ghost"
                        icon="plus-small"
                        class="h-8 rounded-lg border border-border-weak-base bg-background-base px-2.5 pr-3 text-12-medium text-text-base shadow-none transition-colors hover:border-border-strong hover:bg-surface-base-hover active:border-border-base active:bg-surface-base-active focus-visible:border-border-strong focus-visible:bg-surface-base-hover disabled:border-border-weak-base disabled:bg-background-base disabled:text-text-weaker"
                        onClick={() => createMcp()}
                        disabled={!globalSync.updateConfig}
                      >
                        {t("config.mcp.add")}
                      </Button>
                    </div>
                  </Match>
                  <Match when={state.section === "channels"}>
                    <ConfigPaneTitle
                      title={t("config.channels.title")}
                      description={t("config.channels.header")}
                      icon={sectionIcon("channels")}
                    />
                  </Match>
                  <Match when={state.section === "commands"}>
                    <ConfigPaneTitle
                      title={t("config.commands.title")}
                      description={t("config.commands.header")}
                      icon={sectionIcon("commands")}
                    />
                    <div class="mt-4 flex flex-wrap items-center gap-2">
                      <Button
                        size="small"
                        variant="ghost"
                        icon="folder-add-left"
                        class="h-8 rounded-lg border border-border-weak-base bg-background-base px-2.5 pr-3 text-12-medium text-text-base shadow-none transition-colors hover:border-border-strong hover:bg-surface-base-hover active:border-border-base active:bg-surface-base-active focus-visible:border-border-strong focus-visible:bg-surface-base-hover disabled:border-border-weak-base disabled:bg-background-base disabled:text-text-weaker"
                        onClick={() => createCommand()}
                        disabled={!space()?.configRoot || !platform.createLocalFile}
                      >
                        {t("config.commands.create.action")}
                      </Button>
                    </div>
                  </Match>
                  <Match when={state.section === "skills"}>
                    <ConfigPaneTitle
                      title={t("config.skills.title")}
                      description={t("config.skills.header")}
                      icon={sectionIcon("skills")}
                    />
                    <div class="mt-4 flex flex-wrap items-center gap-2">
                      <Button
                        size="small"
                        variant="ghost"
                        icon="folder-add-left"
                        class="h-8 rounded-lg border border-border-weak-base bg-background-base px-2.5 pr-3 text-12-medium text-text-base shadow-none transition-colors hover:border-border-strong hover:bg-surface-base-hover active:border-border-base active:bg-surface-base-active focus-visible:border-border-strong focus-visible:bg-surface-base-hover disabled:border-border-weak-base disabled:bg-background-base disabled:text-text-weaker"
                        onClick={() => createSkill()}
                        disabled={!space()?.skillsRoot || !platform.createLocalFile}
                      >
                        {t("config.skills.create.action")}
                      </Button>
                    </div>
                  </Match>
                  <Match when={state.section === "plugins"}>
                    <ConfigPaneTitle
                      title={t("config.plugins.title")}
                      description={t("config.plugins.header")}
                      icon={sectionIcon("plugins")}
                    />
                  </Match>
                </Switch>
              </div>
              <div
                ref={(el) => {
                  skillsList = el
                }}
                class="config-scrollbar min-h-0 flex-1 overflow-y-auto p-3"
              >
                <div class="flex flex-col">
                  <Switch>
                    <Match when={state.section === "agents-md"}>
                      <For each={agentsMd()}>
                        {(item) => (
                          <ListButton
                            active={state.pick === item.id}
                            title={item.label}
                            note={item.note}
                            meta={short(item.path, space()?.configRoot)}
                            onClick={() => void open(item)}
                          />
                        )}
                      </For>
                    </Match>

                    <Match when={state.section === "providers"}>
                      <Show
                        when={providerList().length > 0}
                        fallback={
                          <div class="rounded-xl border border-dashed border-border-weak-base bg-surface-base px-4 py-8 text-12-regular text-text-weak">
                            {t("config.providers.empty", { query: state.query })}
                          </div>
                        }
                      >
                        <div class="flex flex-col gap-3">
                          <Show when={providerOn().length > 0}>
                            <Suspense
                              fallback={
                                <div class="px-1 py-3 text-12-regular text-text-weak">
                                  {`${t("common.loading")}${t("common.loading.ellipsis")}`}
                                </div>
                              }
                            >
                              <ProviderEnabledBlock
                                items={providerOn()}
                                activePick={state.pick}
                                busyId={state.providerBusy}
                                modelsBadge={(count) => t("config.providers.modelsBadge", { count })}
                                groupLabel={t("config.providers.group.enabled")}
                                onSelect={(id) => setState("pick", `provider:${id}`)}
                                onToggle={toggleProvider}
                              />
                            </Suspense>
                          </Show>

                          <Show when={providerOff().length > 0}>
                            <div class="flex flex-col gap-2">
                              <button
                                type="button"
                                class="flex items-center justify-between gap-3 px-1 cursor-pointer hover:opacity-80"
                                onClick={() => {
                                  if (state.query.trim()) {
                                    console.info("[config] providerOff collapse ignored while searching")
                                    return
                                  }
                                  const next = !state.providerOffCollapsed
                                  setState("providerOffCollapsed", next)
                                  console.info(`[config] providerOffCollapsed toggled next=${String(next)}`)
                                }}
                              >
                                <div class="flex items-center gap-2">
                                  <Icon
                                    name={providerOffExpanded() ? "chevron-down" : "chevron-right"}
                                    size="small"
                                  />
                                  <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                    {t("config.providers.group.existing")}
                                  </div>
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {providerOff().length}
                                </div>
                              </button>
                              <Show when={providerOffExpanded()}>
                                <Suspense
                                  fallback={
                                    <div class="px-1 py-3 text-12-regular text-text-weak">
                                      {`${t("common.loading")}${t("common.loading.ellipsis")}`}
                                    </div>
                                  }
                                >
                                  <ProviderDisabledBlock
                                    items={providerOff()}
                                    activePick={state.pick}
                                    busyId={state.providerBusy}
                                    modelsBadge={(count) => t("config.providers.modelsBadge", { count })}
                                    existingNote={t("config.providers.existingNote")}
                                    onSelect={(id) => setState("pick", `provider:${id}`)}
                                    onToggle={toggleProvider}
                                  />
                                </Suspense>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </Match>

                    <Match when={state.section === "agents"}>
                      <Show
                        when={!agentWait()}
                        fallback={<Wait text={`${t("common.loading")}${t("common.loading.ellipsis")}`} />}
                      >
                        <div class="flex flex-col gap-3">
                          <ConfigSearchBox
                            value={state.agentQuery}
                            placeholder={t("common.search.placeholder")}
                            onInput={(value) => setState("agentQuery", value)}
                          />

                          <Show when={agentBuiltIn().length > 0}>
                            <div class="flex flex-col gap-2">
                              <div class="flex items-center justify-between gap-3 px-1">
                                <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                  {t("config.agents.group.builtin")}
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {agentBuiltIn().length}
                                </div>
                              </div>
                              <div class="flex flex-col gap-2.5">
                                <For each={agentBuiltIn()}>
                                  {(item) => (
                                    <PluginListButton
                                      active={state.pick === item.id}
                                      title={item.label}
                                      note={loadedMap().get(item.label)?.description || item.note}
                                      meta={item.path}
                                      onClick={() => void open(item)}
                                    />
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>

                          <Show when={agentOpenCode().length > 0}>
                            <div class="flex flex-col gap-2">
                              <div class="flex items-center justify-between gap-3 px-1">
                                <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                  {t("config.agents.group.global")}
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {agentOpenCode().length}
                                </div>
                              </div>
                              <div class="flex flex-col gap-2.5">
                                <For each={agentOpenCode()}>
                                  {(item) => (
                                    <PluginListButton
                                      active={state.pick === item.id}
                                      title={item.label}
                                      note={loadedMap().get(item.label)?.description || item.note}
                                      meta={short(item.path, space()?.agentsRoot)}
                                      onClick={() => void open(item)}
                                    />
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>

                          <Show when={agentConfig().length > 0}>
                            <div class="flex flex-col gap-2">
                              <div class="flex items-center justify-between gap-3 px-1">
                                <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                  {t("config.agents.group.jsonc")}
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {agentConfig().length}
                                </div>
                              </div>
                              <div class="flex flex-col gap-2.5">
                                <For each={agentConfig()}>
                                  {(item) => (
                                    <PluginListButton
                                      active={state.pick === item.id}
                                      title={item.label}
                                      note={loadedMap().get(item.label)?.description || item.note}
                                      meta={t("config.agents.jsonc.listNote")}
                                      onClick={() => void open(item)}
                                    />
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>

                          <Show when={agentProject().length > 0}>
                            <div class="flex flex-col">
                              <div class="flex items-center justify-between gap-3 px-1">
                                <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                  {t("config.skills.group.project")}
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {agentProject().length}
                                </div>
                              </div>
                              <div class="mt-2 flex flex-col gap-3">
                                <For each={projectAgentGroups()}>
                                  {([name, items]) => (
                                    <ProjectListGroup
                                      label={name}
                                      path={items[0]?.root}
                                      count={items.length}
                                      open={agentProjectOpen(name)}
                                      onToggle={() => toggleAgentProject(name)}
                                    >
                                      <For each={items}>
                                        {(item) => (
                                          <PluginListButton
                                            active={state.pick === item.id}
                                            title={item.label}
                                            note={loadedMap().get(item.label)?.description || item.note}
                                            meta={[item.origin, short(item.path, item.root)]
                                              .filter(Boolean)
                                              .join(" · ")}
                                            onClick={() => void open(item)}
                                          />
                                        )}
                                      </For>
                                    </ProjectListGroup>
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>

                          <Show when={agentPlugin().length > 0}>
                            <div class="flex flex-col gap-2">
                              <div class="flex items-center justify-between gap-3 px-1">
                                <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                  {t("config.plugins.title")}
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {agentPlugin().length}
                                </div>
                              </div>
                              <div class="flex flex-col gap-2.5">
                                <For each={agentPlugin()}>
                                  {(item) => (
                                    <PluginListButton
                                      active={state.pick === item.id}
                                      title={item.label}
                                      note={loadedMap().get(item.label)?.description || item.note}
                                      meta={[item.project, item.origin, short(item.path, item.root)]
                                        .filter(Boolean)
                                        .join(" · ")}
                                      onClick={() => void open(item)}
                                    />
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </Match>

                    <Match when={state.section === "claws" && clawsSectionEnabled()}>
                      <div class="flex flex-col gap-2.5">
                        <For each={claws()}>
                          {(item) => (
                            <PluginListButton
                              active={state.pick === item.id}
                              title={item.label}
                              note={item.note}
                              meta={item.meta}
                              onClick={() => selectClaw(item.id)}
                              extra={
                                <span
                                  class="rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em]"
                                  classList={{
                                    "border-border-success-base/60 bg-surface-success-base text-text-on-success-base":
                                      item.enabled,
                                    "border-transparent bg-surface-secondary text-text-weak": !item.enabled,
                                  }}
                                >
                                  {item.enabled ? t("config.claws.badge.enabled") : t("config.claws.badge.disabled")}
                                </span>
                              }
                            />
                          )}
                        </For>
                      </div>
                    </Match>

                    <Match when={state.section === "mcp"}>
                      <Show
                        when={mcpGlobal().length > 0 || mcpProject().length > 0}
                        fallback={
                          <div class="rounded-xl border border-dashed border-border-weak-base bg-surface-base px-4 py-8 text-12-regular text-text-weak">
                            {t("config.mcp.empty")}
                          </div>
                        }
                      >
                        <div class="flex flex-col gap-3">
                          <Show when={mcpGlobal().length > 0}>
                            <div class="flex flex-col gap-2">
                              <div class="flex items-center justify-between gap-3 px-1">
                                <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                  {t("config.mcp.group.global")}
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {mcpGlobal().length}
                                </div>
                              </div>
                              <div class="flex flex-col gap-2.5">
                                <For each={mcpGlobal()}>
                                  {(server) => (
                                    <PluginListButton
                                      active={state.pick === server.id}
                                      title={server.name}
                                      note={server.detail}
                                      meta={server.type !== "unknown" ? server.type : undefined}
                                      onClick={() => setState("pick", server.id)}
                                      extra={
                                        <Toggle
                                          checked={server.status === "connected"}
                                          disabled={state.mcpBusy === server.name}
                                          onChange={(value) => toggleMcp(server.name, value)}
                                          hideLabel
                                        >
                                          {server.name}
                                        </Toggle>
                                      }
                                    />
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>
                          <Show when={mcpProject().length > 0}>
                            <ProjectListGroup
                              label={mcpProjectName()}
                              path={sync.data.path?.directory}
                              count={mcpProject().length}
                              open={mcpProjectOpen()}
                              onToggle={toggleMcpProject}
                              onAdd={() => createMcp(sync.data.path?.directory ?? "")}
                              addLabel={t("config.mcp.add")}
                              addDisabled={!sync.data.path?.directory}
                            >
                              <For each={mcpProject()}>
                                {(server) => (
                                  <PluginListButton
                                    active={server.draft ? state.pick === MCP_NEW : state.pick === server.id}
                                    title={server.name}
                                    note={server.detail}
                                    meta={server.type !== "unknown" ? server.type : undefined}
                                    onClick={() => setState("pick", server.draft ? MCP_NEW : server.id)}
                                    extra={
                                      <Show when={!server.draft}>
                                        <Toggle
                                          checked={server.status === "connected"}
                                          disabled={state.mcpBusy === server.name}
                                          onChange={(value) => toggleMcp(server.name, value)}
                                          hideLabel
                                        >
                                          {server.name}
                                        </Toggle>
                                      </Show>
                                    }
                                  />
                                )}
                              </For>
                            </ProjectListGroup>
                          </Show>
                        </div>
                      </Show>
                    </Match>

                    <Match when={state.section === "channels"}>
                      <div class="flex flex-col gap-2.5">
                        <For each={channelMiddleItems()}>
                          {(item) => (
                            <PluginListButton
                              active={item.active}
                              title={item.title}
                              note={item.note}
                              meta={item.count > 0 ? String(item.count) : undefined}
                              onClick={() => setState("pick", item.pick)}
                            />
                          )}
                        </For>
                      </div>
                    </Match>

                    <Match when={state.section === "commands"}>
                      <Show
                        when={!commandLoading()}
                        fallback={<Wait text={`${t("common.loading")}${t("common.loading.ellipsis")}`} />}
                      >
                        <div class="flex flex-col gap-3">
                          <ConfigSearchBox
                            value={state.commandQuery}
                            placeholder={t("common.search.placeholder")}
                            onInput={(value) => setState("commandQuery", value)}
                          />

                          <Show when={commandGlobal().length > 0}>
                            <div class="flex flex-col gap-2">
                              <div class="flex items-center justify-between gap-3 px-1">
                                <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                  {t("config.commands.group.global")}
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {commandGlobal().length}
                                </div>
                              </div>
                              <div class="flex flex-col gap-2.5">
                                <For each={commandGlobal()}>
                                  {(item) => (
                                    <PluginListButton
                                      active={state.pick === item.id}
                                      title={item.label}
                                      note={item.note}
                                      meta={item.path ? short(item.path, item.root) : undefined}
                                      onClick={() => void open(item)}
                                    />
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>
                          <Show when={projectCommands().length > 0}>
                            <div class="flex flex-col">
                              <div class="flex items-center justify-between gap-3 px-1">
                                <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                  {t("config.commands.group.project")}
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {projectCommands().length}
                                </div>
                              </div>
                              <div class="mt-2 flex flex-col gap-3">
                                <For each={projectCommands()}>
                                  {(group) => (
                                    <ProjectListGroup
                                      label={group.label}
                                      path={group.path}
                                      count={group.items.length}
                                      open={commandProjectOpen(group.label)}
                                      onToggle={() => toggleCommandProject(group.label)}
                                      onAdd={() => group.path && createCommand(group.path, group.label)}
                                      addLabel={t("config.commands.create.action")}
                                      addDisabled={!group.path || !platform.createLocalFile}
                                    >
                                      <For each={group.items}>
                                        {(item) => (
                                          <PluginListButton
                                            active={state.pick === item.id}
                                            title={item.label}
                                            note={item.note}
                                            meta={item.path ? short(item.path, item.root) : undefined}
                                            onClick={() =>
                                              item.id === COMMAND_NEW ? setState("pick", COMMAND_NEW) : void open(item)
                                            }
                                          />
                                        )}
                                      </For>
                                    </ProjectListGroup>
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </Match>

                    <Match when={state.section === "skills"}>
                      <Show
                        when={!skillWait()}
                        fallback={<Wait text={`${t("common.loading")}${t("common.loading.ellipsis")}`} />}
                      >
                        <div class="flex flex-col gap-3">
                          <div class="flex flex-col gap-2">
                            <SkillListButton
                              active={state.skillPanel === "market"}
                              title={t("config.skills.market.action")}
                              note={t("config.skills.market.description")}
                              icon="shopping-bag"
                              onClick={openSkillMarket}
                            />
                            <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2.5">
                              <input
                                type="text"
                                value={state.skillQuery}
                                placeholder={t("common.search.placeholder")}
                                class="w-full bg-transparent text-13-regular text-text-base outline-none placeholder:text-text-weak"
                                onInput={(event) => setState("skillQuery", event.currentTarget.value)}
                              />
                            </div>
                          </div>

                          <Show when={skillOpenCode().length > 0}>
                            <div class="flex flex-col gap-2">
                              <div class="flex items-center justify-between gap-3 px-1">
                                <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                  {t("config.skills.group.opencode")}
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {skillOpenCode().length}
                                </div>
                              </div>
                              <div class="flex flex-col gap-2.5">
                                <For each={skillOpenCode()}>
                                  {(item) => (
                                    <SkillListButton
                                      active={state.pick === item.id}
                                      title={item.label}
                                      note={item.note}
                                      warn={!!item.warn}
                                      warnLabel={item.warn ? t("config.skills.badge.needsMetadata") : undefined}
                                      deletable={item.editable}
                                      onDelete={() => void deleteSkill(item)}
                                      onClick={() => void open(item)}
                                    />
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>

                          <Show when={skillClaude().length > 0}>
                            <div class="flex flex-col gap-2">
                              <div class="flex items-center justify-between gap-3 px-1">
                                <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                  {t("config.skills.group.claude")}
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {skillClaude().length}
                                </div>
                              </div>
                              <div class="flex flex-col gap-2.5">
                                <For each={skillClaude()}>
                                  {(item) => (
                                    <SkillListButton
                                      active={state.pick === item.id}
                                      title={item.label}
                                      note={item.note}
                                      warn={!!item.warn}
                                      warnLabel={item.warn ? t("config.skills.badge.needsMetadata") : undefined}
                                      deletable={item.editable}
                                      onDelete={() => void deleteSkill(item)}
                                      onClick={() => void open(item)}
                                    />
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>

                          <Show when={skillExternal().length > 0}>
                            <div class="flex flex-col gap-2">
                              <div class="flex items-center justify-between gap-3 px-1">
                                <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                  {t("config.skills.group.external")}
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {skillExternal().length}
                                </div>
                              </div>
                              <div class="flex flex-col gap-2.5">
                                <For each={skillExternal()}>
                                  {(item) => (
                                    <SkillListButton
                                      active={state.pick === item.id}
                                      title={item.label}
                                      note={item.note}
                                      warn={!!item.warn}
                                      warnLabel={item.warn ? t("config.skills.badge.needsMetadata") : undefined}
                                      deletable={item.editable}
                                      onDelete={() => void deleteSkill(item)}
                                      onClick={() => void open(item)}
                                    />
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>

                          <Show when={skillProject().length > 0}>
                            <div class="flex flex-col">
                              <div class="flex items-center justify-between gap-3 px-1">
                                <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                  {t("config.skills.group.project")}
                                </div>
                                <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {skillProject().length}
                                </div>
                              </div>
                              <div class="mt-2 flex flex-col gap-3">
                                <For each={projectSkills()}>
                                  {(group) => (
                                    <ProjectListGroup
                                      label={group.label}
                                      path={group.path}
                                      count={group.items.length}
                                      open={groupOpen(group.path ?? group.label)}
                                      onToggle={() => keepSkillsScroll(() => toggleGroup(group.path ?? group.label))}
                                      onAdd={() =>
                                        group.path && keepSkillsScroll(() => createSkill(group.path, group.label))
                                      }
                                      addLabel={t("config.skills.create.action")}
                                      addDisabled={!group.path || !platform.createLocalFile}
                                    >
                                      <For each={group.items}>
                                        {(item) => (
                                          <SkillListButton
                                            active={state.pick === item.id}
                                            title={item.label}
                                            note={item.note}
                                            warn={!!item.warn}
                                            warnLabel={item.warn ? t("config.skills.badge.needsMetadata") : undefined}
                                            deletable={item.editable}
                                            onDelete={() => void deleteSkill(item)}
                                            onClick={() =>
                                              keepSkillsScroll(() =>
                                                item.id === SKILL_NEW ? setState("pick", SKILL_NEW) : void open(item),
                                              )
                                            }
                                          />
                                        )}
                                      </For>
                                    </ProjectListGroup>
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </Match>

                    <Match when={state.section === "plugins"}>
                      <div class="flex flex-col gap-3">
                        <ConfigSearchBox
                          value={state.pluginQuery}
                          placeholder={t("common.search.placeholder")}
                          onInput={(value) => setState("pluginQuery", value)}
                        />

                        <Show when={pluginGlobal().length > 0}>
                          <div class="flex flex-col gap-2">
                            <div class="flex items-center justify-between gap-3 px-1">
                              <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                {t("config.plugins.group.global")}
                              </div>
                              <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                {pluginGlobal().length}
                              </div>
                            </div>
                            <div class="flex flex-col gap-2.5">
                              <For each={pluginGlobal()}>
                                {(item) => (
                                  <PluginListButton
                                    active={state.pick === item.id}
                                    title={item.label}
                                    note={item.exists ? undefined : t("config.plugins.note.missing")}
                                    meta={item.path ? short(item.path, space()?.pluginsRoot) : undefined}
                                    warn={item.enabled && !item.exists}
                                    onClick={() => {
                                      setState("pick", item.id)
                                      const doc = docs().get(item.id)
                                      if (!doc) return
                                      void open(doc)
                                    }}
                                    extra={
                                      <Toggle
                                        checked={item.enabled}
                                        onChange={(value) => togglePlugin(item, value)}
                                        hideLabel
                                      >
                                        {item.label}
                                      </Toggle>
                                    }
                                  />
                                )}
                              </For>
                            </div>
                          </div>
                        </Show>

                        <Show when={pluginProject().length > 0}>
                          <div class="flex flex-col">
                            <div class="flex items-center justify-between gap-3 px-1">
                              <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                                {t("config.plugins.group.project")}
                              </div>
                              <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                {pluginProject().length}
                              </div>
                            </div>
                            <div class="mt-2 flex flex-col gap-3">
                              <For each={projectPlugins()}>
                                {(group) => (
                                  <ProjectListGroup
                                    label={group.label}
                                    path={group.path}
                                    count={group.items.length}
                                    open={groupOpen(`plugin-group:${group.path ?? group.label}`)}
                                    onToggle={() => toggleGroup(`plugin-group:${group.path ?? group.label}`)}
                                  >
                                    <For each={group.items}>
                                      {(item) => (
                                        <PluginListButton
                                          active={state.pick === item.id}
                                          title={item.label}
                                          note={item.exists ? undefined : t("config.plugins.note.missing")}
                                          meta={item.origin ? `${item.origin} · ${item.path}` : item.path}
                                          warn={item.enabled && !item.exists}
                                          onClick={() => {
                                            setState("pick", item.id)
                                            const doc = docs().get(item.id)
                                            if (!doc) return
                                            void open(doc)
                                          }}
                                          extra={
                                            <Toggle
                                              checked={item.enabled}
                                              onChange={(value) => togglePlugin(item, value)}
                                              hideLabel
                                            >
                                              {item.label}
                                            </Toggle>
                                          }
                                        />
                                      )}
                                    </For>
                                  </ProjectListGroup>
                                )}
                              </For>
                            </div>
                          </div>
                        </Show>
                      </div>
                    </Match>
                  </Switch>
                </div>
              </div>
            </div>
          </section>

          <main
            class="min-h-0 min-w-0 flex-1 overflow-hidden bg-[linear-gradient(155deg,color-mix(in_srgb,var(--surface-brand-base)_2%,var(--background-base)),var(--background-base)_38%)] transition-shadow duration-150"
            classList={{ [CONFIG_PANE_FOCUS_CLASS]: state.focusVisible && state.focusPane === "right" }}
            data-config-pane="right"
            data-focused={state.focusVisible && state.focusPane === "right" ? "true" : undefined}
            onMouseDown={() => clearKeyboardFocus("right")}
          >
            <Switch>
              <Match when={state.section === "providers"}>
                <Show
                  when={selectedCustom() || state.pick === CUSTOM_NEW}
                  fallback={
                    <ProviderDetail
                      item={selectedProvider()}
                      busy={state.providerBusy === selectedProvider()?.id}
                      onToggle={toggleProvider}
                      onSignOut={signOutProvider}
                    />
                  }
                >
                  <CustomEditor
                    item={selectedCustom()}
                    form={state.custom}
                    busy={state.providerBusy === selectedCustom()?.id}
                    onToggle={toggleProvider}
                    onField={setCustomField}
                    onModel={setCustomModel}
                    onModelConfig={setCustomModelConfig}
                    onToggleModelConfig={toggleCustomModelConfig}
                    onHeader={setCustomHeader}
                    onAddModel={addCustomModel}
                    onRemoveModel={removeCustomModel}
                    onAddHeader={addCustomHeader}
                    onRemoveHeader={removeCustomHeader}
                    onSave={() => void saveCustom()}
                    onDelete={() => void deleteCustom()}
                    onCreate={createCustomProvider}
                    onSecret={toggleCustomSecret}
                    onCopyApiKey={() => void copyCustomApiKey()}
                    apiKeyCopied={state.copied === "custom-api-key"}
                    onAddFetchedModel={addFetchedCustomModel}
                  />
                </Show>
              </Match>

              <Match when={state.section === "claws" && clawsSectionEnabled()}>
                <Show
                  when={selectedClaw()}
                  fallback={<div class="px-5 py-10 text-13-regular text-text-weak">{t("config.claws.empty")}</div>}
                >
                  <Switch
                    fallback={
                      <ClawEditor
                        item={selectedClaw()}
                        info={extraAgentInfoState()}
                        infoLoading={extraAgentInfoLoading()}
                        form={state.claw}
                        dirty={clawDirty()}
                        busy={openclawLoading()}
                        canTest={!!platform.testOpenclawConfig}
                        canDetect={!!platform.detectOpenclawConfig}
                        onChange={setClaw}
                        onSave={() => void saveClaw()}
                        onTest={() => void testClaw()}
                        onDetect={() => void detectClaw()}
                        onAbort={platform.abortOpenclawTest ? () => void abortClaw() : undefined}
                      />
                    }
                  >
                    <Match when={selectedClaw()?.id === "claw:hermes"}>
                      <HermesEditor
                        item={selectedClaw()}
                        info={extraAgentInfoState()}
                        infoLoading={extraAgentInfoLoading()}
                        form={state.hm}
                        dirty={hmDirty()}
                        busy={hermesLoading()}
                        canTest={!!platform.testHermesConfig}
                        onChange={setHm}
                        onChooseDir={chooseHermesDir}
                        onSave={() => void saveHm()}
                        onTest={() => void testHm()}
                        onAbort={platform.abortHermesTest ? () => void abortHm() : undefined}
                      />
                    </Match>
                    <Match when={cliAgentDescriptors().find((agent) => `claw:${agent.id}` === selectedClaw()?.id)}>
                      {(descriptor) => (
                        <CliAgentEditor
                          item={selectedClaw()}
                          descriptor={descriptor()}
                          info={cliAgentInfo[descriptor().id]}
                          infoLoading={cliAgentLoading[descriptor().id]?.info ?? false}
                          form={state.cliAgents[descriptor().id] ?? cliAgentCfg()}
                          dirty={cliAgentDirty(descriptor().id)}
                          busy={cliAgentLoading[descriptor().id]?.config ?? false}
                          canTest={!!platform.cliAgents}
                          plugins={descriptor().id === "dsh" ? dshPlugins.inventory : undefined}
                          pluginsLoading={descriptor().id === "dsh" ? dshPlugins.loading : false}
                          pluginsTogglingId={descriptor().id === "dsh" ? dshPlugins.togglingId : undefined}
                          pluginsQuery={descriptor().id === "dsh" ? dshPlugins.query : ""}
                          pluginsShowDisabled={descriptor().id === "dsh" ? dshPlugins.showDisabled : true}
                          pluginsExpandedId={descriptor().id === "dsh" ? dshPlugins.expandedId : undefined}
                          onChange={(key, value) => setCliAgent(descriptor().id, key, value)}
                          onSave={() => void saveCliAgent(descriptor().id)}
                          onTest={() => void testCliAgent(descriptor().id)}
                          onRefresh={() => void refreshCliAgentInfo(descriptor().id)}
                          onToggleSecret={descriptor().id === "dsh" ? () => toggleDshSecret() : undefined}
                          onCopyApiKey={descriptor().id === "dsh" ? () => void copyDshApiKey() : undefined}
                          apiKeyCopied={descriptor().id === "dsh" && state.copied === "dsh-api-key"}
                          onLoadPlugins={
                            descriptor().id === "dsh" && platform.cliAgents?.listDshPlugins
                              ? () => void loadDshPlugins()
                              : undefined
                          }
                          onPluginsQuery={
                            descriptor().id === "dsh" ? (value) => setDshPlugins("query", value) : undefined
                          }
                          onPluginsShowDisabled={
                            descriptor().id === "dsh" ? (value) => setDshPlugins("showDisabled", value) : undefined
                          }
                          onPluginsExpand={
                            descriptor().id === "dsh" ? (id) => setDshPlugins("expandedId", id) : undefined
                          }
                          onSetPluginEnabled={
                            descriptor().id === "dsh" && platform.cliAgents?.setDshPluginEnabled
                              ? (id, enabled) => void setDshPluginEnabled(id, enabled)
                              : undefined
                          }
                        />
                      )}
                    </Match>
                    <Match when={selectedClaw()?.id === "claw:genericagent"}>
                      <GenericAgentEditor
                        item={selectedClaw()}
                        info={extraAgentInfoState()}
                        infoLoading={extraAgentInfoLoading()}
                        form={state.ga}
                        dirty={gaDirty()}
                        busy={genericagentLoading()}
                        canTest={!!platform.testGenericagentConfig}
                        onChange={setGa}
                        onChooseDir={chooseGenericAgentDir}
                        onSave={() => void saveGa()}
                        onTest={() => void testGa()}
                        onAbort={platform.abortGenericagentTest ? () => void abortGa() : undefined}
                      />
                    </Match>
                  </Switch>
                </Show>
              </Match>

              <Match when={state.section === "plugins"}>
                <Show
                  when={selectedPlugin()?.path}
                  fallback={
                    <div class="bg-surface-base px-4 py-10">
                      <div class="text-20-medium text-text-strong">
                        {selectedPlugin()?.label ?? t("config.plugins.select")}
                      </div>
                      <div class="mt-2 text-12-regular text-text-weak">
                        <Show when={selectedPlugin()} fallback={t("config.plugins.empty")}>
                          {t("config.plugins.missingDetail")}
                        </Show>
                      </div>
                      <Show when={selectedPlugin()}>
                        <div class="mt-4">
                          <Toggle
                            checked={!!selectedPlugin()?.enabled}
                            onChange={(value) => selectedPlugin() && togglePlugin(selectedPlugin()!, value)}
                          >
                            {t("config.provider.badge.enabled")}
                          </Toggle>
                        </div>
                      </Show>
                    </div>
                  }
                >
                  <Editor
                    item={currentDoc()}
                    text={state.text}
                    dirty={dirty()}
                    busy={state.busy}
                    onInput={(value) => setState("text", value)}
                    onSave={() => void save()}
                    onOpenFolder={currentDoc() ? openFolder : undefined}
                    extra={
                      <Toggle
                        checked={!!currentPlugin()?.enabled}
                        onChange={(value) => currentPlugin() && togglePlugin(currentPlugin()!, value)}
                      >
                        {t("config.provider.badge.enabled")}
                      </Toggle>
                    }
                    empty={t("config.plugins.empty")}
                  />
                </Show>
              </Match>

              <Match when={state.section === "mcp"}>
                <Show
                  when={selectedMcpName() || state.pick === MCP_NEW}
                  fallback={
                    <div class="flex h-full items-center justify-center px-4 py-10">
                      <div class="text-13-regular text-text-weak">{t("config.mcp.editor.select")}</div>
                    </div>
                  }
                >
                  {(serverName) => {
                    const isNew = () => state.pick === MCP_NEW
                    const displayName = () => (isNew() ? t("config.mcp.add") : serverName())
                    return (
                      <div class="flex h-full min-h-0 flex-col">
                        <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border-weak-base px-6 py-4">
                          <div class="min-w-0">
                            <div class="flex items-center gap-2">
                              <div class="truncate text-20-medium text-text-strong">{displayName()}</div>
                              <Show when={!isNew()}>
                                <span class="shrink-0 rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                                  {state.mcpForm.type === "local"
                                    ? t("config.mcp.type.local")
                                    : t("config.mcp.type.remote")}
                                </span>
                                <span
                                  class="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em]"
                                  classList={{
                                    "border-border-success-base/60 bg-surface-success-base text-text-on-success-base":
                                      selectedMcpStatus() === "connected",
                                    "border-transparent bg-surface-secondary text-text-weak":
                                      selectedMcpStatus() !== "connected",
                                  }}
                                >
                                  {selectedMcpStatus()}
                                </span>
                              </Show>
                            </div>
                          </div>
                          <div class="flex shrink-0 items-center gap-2">
                            <Show when={!isNew()}>
                              <Button
                                size="small"
                                variant="ghost"
                                icon="trash"
                                onClick={() =>
                                  void deleteMcpServer().catch((err: unknown) =>
                                    showToast({
                                      title: language.t("common.requestFailed"),
                                      description: err instanceof Error ? err.message : String(err),
                                    }),
                                  )
                                }
                              >
                                {t("config.mcp.editor.delete")}
                              </Button>
                            </Show>
                            <Show when={isNew()}>
                              <Button
                                size="small"
                                variant="ghost"
                                icon="close"
                                disabled={state.mcpSaving}
                                onClick={cancelMcpCreate}
                              >
                                {t("common.cancel")}
                              </Button>
                            </Show>
                            <SaveButton
                              disabled={!state.mcpDirty || state.mcpSaving || (isNew() && !state.mcpNewName.trim())}
                              onClick={() =>
                                void saveMcpServer().catch((err: unknown) =>
                                  showToast({
                                    title: language.t("common.requestFailed"),
                                    description: err instanceof Error ? err.message : String(err),
                                  }),
                                )
                              }
                              label={state.mcpSaving ? "..." : t("config.mcp.editor.save")}
                            />
                          </div>
                        </div>
                        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-6">
                          <div class="flex max-w-[920px] flex-col gap-6">
                            <Show when={isNew()}>
                              <TextField
                                label={t("config.mcp.editor.name")}
                                placeholder="my-mcp-server"
                                value={state.mcpNewName}
                                onChange={(v) => {
                                  setState("mcpNewName", v ?? "")
                                  setState("mcpDirty", true)
                                }}
                              />
                            </Show>
                            <div class="flex flex-col gap-1">
                              <span class="text-12-medium text-text-base">{t("config.mcp.editor.type")}</span>
                              <Select
                                options={[
                                  { value: "local" as const, label: t("config.mcp.type.local") },
                                  { value: "remote" as const, label: t("config.mcp.type.remote") },
                                ]}
                                current={
                                  state.mcpForm.type === "local"
                                    ? { value: "local" as const, label: t("config.mcp.type.local") }
                                    : { value: "remote" as const, label: t("config.mcp.type.remote") }
                                }
                                value={(o) => o.value}
                                label={(o) => o.label}
                                onSelect={(o) => o && setMcpField("type", o.value)}
                                variant="secondary"
                                size="large"
                              />
                            </div>
                            <Switch>
                              <Match when={state.mcpForm.type === "local"}>
                                <TextField
                                  label={t("config.mcp.editor.command")}
                                  placeholder="npx -y @modelcontextprotocol/server-filesystem /path"
                                  value={state.mcpForm.command}
                                  onChange={(v) => setMcpField("command", v ?? "")}
                                />
                                <TextField
                                  label={t("config.mcp.editor.environment")}
                                  placeholder={"KEY=value\nKEY2=value2"}
                                  value={state.mcpForm.environment}
                                  onChange={(v) => setMcpField("environment", v ?? "")}
                                  multiline
                                  rows={3}
                                />
                              </Match>
                              <Match when={state.mcpForm.type === "remote"}>
                                <TextField
                                  label={t("config.mcp.editor.url")}
                                  placeholder="https://mcp.example.com/sse"
                                  value={state.mcpForm.url}
                                  onChange={(v) => setMcpField("url", v ?? "")}
                                />
                                <TextField
                                  label={t("config.mcp.editor.headers")}
                                  placeholder={"Authorization=Bearer token\nX-Custom=value"}
                                  value={state.mcpForm.headers}
                                  onChange={(v) => setMcpField("headers", v ?? "")}
                                  multiline
                                  rows={3}
                                />
                              </Match>
                            </Switch>
                          </div>
                        </div>
                      </div>
                    )
                  }}
                </Show>
              </Match>

              <Match when={state.section === "channels"}>
                <Switch
                  fallback={
                    <div class="flex h-full items-center justify-center px-4 py-10">
                      <div class="text-13-regular text-text-weak">{t("config.channels.editor.select")}</div>
                    </div>
                  }
                >
                  <Match when={selectedChannelPlatform() === "feishu"}>
                    <ConfigChannelsDetail platform="feishu" />
                  </Match>
                  <Match when={selectedChannelPlatform() === "discord"}>
                    <ConfigChannelsDetail platform="discord" />
                  </Match>
                </Switch>
              </Match>

              <Match when={state.section === "commands"}>
                <Show
                  when={state.pick !== COMMAND_NEW}
                  fallback={
                    <CommandCreator
                      root={
                        state.cmdCreateDir || (space()?.configRoot ? join(space()!.configRoot!, "commands") : undefined)
                      }
                      title={state.cmdTitle}
                      text={state.text}
                      busy={state.cmdSaving}
                      err={state.cmdErr || undefined}
                      onTitle={setCommandTitle}
                      onInput={(value) => setState("text", value)}
                      onSave={() => void saveCommand()}
                      onCancel={cancelCommandCreate}
                    />
                  }
                >
                  <Editor
                    item={currentDoc()}
                    text={state.text}
                    dirty={dirty()}
                    busy={state.busy}
                    onInput={(value) => setState("text", value)}
                    onSave={() => void save()}
                    onOpenFolder={currentDoc() ? openFolder : undefined}
                    onDelete={
                      currentDoc()?.id.startsWith("cmd:") && platform.deleteLocalFile
                        ? () => void deleteCommand(currentDoc())
                        : undefined
                    }
                    empty={t("config.commands.select")}
                    markdown
                  />
                </Show>
              </Match>
              <Match when={state.section === "skills"}>
                <Show
                  when={skillWait()}
                  fallback={
                    <Switch>
                      <Match when={state.skillPanel === "market"}>
                        <SkillMarket
                          repos={skillMarketRepos()}
                          selected={state.skillMarketRepo}
                          skills={marketSkills().skills}
                          loading={marketSkillsLoading()}
                          loadMeta={marketLoadMeta()}
                          error={marketSkills().error}
                          installing={state.skillMarketInstalling}
                          installedGlobal={installedGlobalSkillFolders()}
                          projectTargets={skillMarketProjectTargets()}
                          globalRoot={space()?.skillsRoot}
                          customValue={state.skillMarketCustomInput}
                          customError={state.skillMarketCustomError}
                          onSelect={selectSkillMarketRepo}
                          onInstall={(item, scope, target) => void installMarketSkill(item, scope, target)}
                          onReload={loadSelectedMarketRepo}
                          onCustomInput={setCustomSkillMarketInput}
                          onCustomSubmit={loadCustomSkillMarketRepo}
                        />
                      </Match>
                      <Match when={state.pick === SKILL_NEW}>
                        <SkillCreator
                          root={state.skillCreateRoot || space()?.skillsRoot}
                          title={state.skillTitle}
                          text={state.text}
                          busy={state.skillSaving}
                          err={state.skillErr || undefined}
                          onTitle={setSkillTitle}
                          onInput={(value) => setState("text", value)}
                          onSave={() => void saveSkill()}
                          onCancel={cancelSkillCreate}
                        />
                      </Match>
                      <Match when={true}>
                        <Editor
                          item={currentDoc()}
                          text={state.text}
                          dirty={dirty()}
                          busy={state.busy}
                          tree={currentTree()}
                          treeRoot={currentSkillRoot()}
                          treeBusy={tree.loading}
                          treeOpen={treeOpen}
                          onTreeToggle={toggleTree}
                          onInput={(value) => setState("text", value)}
                          onSave={() => void save()}
                          onOpenFolder={currentDoc() ? openFolder : undefined}
                          onCopyPath={currentDoc() ? copyPath : undefined}
                          copyPathCopied={state.copied === "config-path"}
                          warn={currentDoc()?.warn}
                          empty={t("config.skills.empty")}
                          markdown
                        />
                      </Match>
                    </Switch>
                  }
                >
                  <Wait text={`${t("common.loading")}${t("common.loading.ellipsis")}`} />
                </Show>
              </Match>

              <Match when={state.section === "agents"}>
                <Show
                  when={!agentWait()}
                  fallback={<Wait text={`${t("common.loading")}${t("common.loading.ellipsis")}`} />}
                >
                  <Show
                    when={currentJsoncAgent()}
                    fallback={
                      <Editor
                        item={currentDoc()}
                        text={state.text}
                        dirty={dirty()}
                        busy={state.busy}
                        onInput={(value) => setState("text", value)}
                        onSave={() => void save()}
                        onOpenFolder={file(currentDoc()?.path ?? "") ? openFolder : undefined}
                        onCopyPath={file(currentDoc()?.path ?? "") ? copyPath : undefined}
                        copyPathCopied={state.copied === "config-path"}
                        extra={
                          <Show when={currentAgent()}>
                            <span class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                              {agentModeLabel(loadedMap().get(currentAgent()!.label)?.mode)}
                            </span>
                          </Show>
                        }
                        empty={t("config.agents.empty")}
                        markdown
                      />
                    }
                  >
                    {(name) => (
                      <JsoncAgentEditor
                        name={name()}
                        config={configFileAgents()?.[name()]}
                        onSave={(form) => saveJsoncAgent(name(), form)}
                      />
                    )}
                  </Show>
                </Show>
              </Match>

              <Match when={state.section === "agents-md"}>
                <Editor
                  item={currentDoc()}
                  text={state.text}
                  dirty={dirty()}
                  busy={state.busy}
                  onInput={(value) => setState("text", value)}
                  onSave={() => void save()}
                  onOpenFolder={currentDoc() ? openFolder : undefined}
                  empty={t("config.agentsMd.empty")}
                  markdown
                />
              </Match>
            </Switch>
          </main>
        </div>
      </div>
    </div>
  )
}
function commandSafeName(title: string) {
  return title
    .trim()
    .replace(/^\//, "")
    .replace(/[^a-zA-Z0-9_\-\/]/g, "-")
    .replace(/^-+|-+$/g, "")
}

function CommandCreator(props: {
  root?: string
  title: string
  text: string
  busy: boolean
  err?: string
  onTitle: (value: string) => void
  onInput: (value: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const language = useLanguage()

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="border-b border-border-weak-base px-6 py-4">
        <div class="flex items-center gap-3">
          <input
            type="text"
            class="w-full bg-transparent text-20-medium text-text-strong outline-none placeholder:text-text-weaker"
            placeholder={language.t("config.commands.create.placeholder")}
            value={props.title}
            onInput={(e) => props.onTitle(e.currentTarget.value)}
            disabled={props.busy}
          />
          <Button size="small" variant="ghost" icon="close" onClick={props.onCancel} disabled={props.busy}>
            {language.t("common.cancel")}
          </Button>
          <SaveButton
            onClick={props.onSave}
            disabled={props.busy || !props.title.trim()}
            label={props.busy ? language.t("common.loading.ellipsis") : language.t("common.save")}
          />
        </div>
        <Show when={props.root}>
          {(root) => (
            <div class="mt-2 break-all font-mono text-[12px] leading-5 text-text-weak">
              {join(root(), `${commandSafeName(props.title) || "command"}.md`)}
            </div>
          )}
        </Show>
      </div>
      <Show when={props.err}>
        <div class="border-b border-border-weak-base bg-surface-danger-base/10 px-6 py-2 text-12-regular text-text-danger">
          {props.err}
        </div>
      </Show>
      <div class="min-h-0 flex-1 px-5 py-4">
        <MarkdownField
          text={props.text}
          busy={props.busy}
          editable={!props.busy}
          onInput={props.onInput}
          paint={paint}
          preview
        />
      </div>
    </div>
  )
}

const yaml = (value: string) => JSON.stringify(value.trim())

function skillTemplate(title: string) {
  const name = title.trim()
  return [
    "---",
    `name: ${yaml(name)}`,
    'description: "Describe when to use this skill."',
    "---",
    "",
    name ? `# ${name}` : "# New Skill",
    "",
    "Add instructions, workflows, and examples here.",
    "",
  ].join("\n")
}

function SkillCreator(props: {
  root?: string
  title: string
  text: string
  busy: boolean
  err?: string
  onTitle: (value: string) => void
  onInput: (value: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const language = useLanguage()

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="border-b border-border-weak-base px-5 py-4">
        <div class="flex items-center gap-3">
          <input
            type="text"
            class="w-full bg-transparent text-20-medium text-text-strong outline-none placeholder:text-text-weaker"
            placeholder={language.t("config.skills.create.title")}
            value={props.title}
            onInput={(event) => props.onTitle(event.currentTarget.value)}
            disabled={props.busy}
          />
          <span class="shrink-0 rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
            {language.t("config.editor.badge.editable")}
          </span>
          <Button size="small" variant="ghost" icon="close" onClick={props.onCancel} disabled={props.busy}>
            {language.t("common.cancel")}
          </Button>
          <SaveButton
            label={language.t("common.save")}
            onClick={props.onSave}
            disabled={props.busy || !props.title.trim()}
          />
        </div>
      </div>
      <Show when={props.err}>
        <div class="border-b border-border-weak-base bg-surface-danger-base/10 px-6 py-2 text-12-regular text-text-danger">
          {props.err}
        </div>
      </Show>
      <div class="grid min-h-0 flex-1 auto-rows-fr gap-4 px-5 py-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div class="flex min-h-0 flex-col gap-4">
          <div class="min-h-0 flex-1">
            <MarkdownField
              text={props.text}
              busy={props.busy}
              editable={true}
              onInput={props.onInput}
              paint={paint}
              preview
            />
          </div>
        </div>
        <div class="flex h-full min-h-0 flex-col rounded-xl border border-border-weak-base bg-background-base p-3">
          <div class="mb-3 text-11-medium uppercase tracking-[0.08em] text-text-weak">
            {language.t("config.editor.structure")}
          </div>
          <div class="text-12-regular text-text-weak">{language.t("config.skills.create.structure")}</div>
        </div>
      </div>
    </div>
  )
}

function SkillMarketLoading(props: { meta?: SkillMarketLoadMeta }) {
  const language = useLanguage()
  const seconds = () => String(Math.round((props.meta?.timeoutMs ?? SKILL_MARKET_LOAD_TIMEOUT_MS) / 1000))
  const stage = () => {
    if (props.meta?.stage === "skills") return language.t("config.skills.market.loading.stage.skills")
    return language.t("config.skills.market.loading.stage.index")
  }
  const progress = () => {
    const meta = props.meta
    if (!meta || meta.total === 0) return
    return language.t("config.skills.market.loading.progress", {
      completed: String(meta.completed),
      total: String(meta.total),
      failed: String(meta.failed),
    })
  }

  return (
    <div class="rounded-xl border border-border-weak-base bg-background-base p-5">
      <div class="flex items-start gap-3">
        <Spinner class="mt-0.5 size-4 shrink-0 text-icon-weak-base" />
        <div class="min-w-0">
          <div class="text-13-medium text-text-strong">
            {language.t("config.skills.market.loading.title", {
              repo: props.meta?.repo ?? language.t("config.skills.market.skills"),
            })}
          </div>
          <div class="mt-2 text-12-regular leading-5 text-text-weak">
            {language.t("config.skills.market.loading.description", { seconds: seconds() })}
          </div>
          <div class="mt-3 rounded-lg border border-border-weak-base bg-background-panel px-3 py-2">
            <div class="text-12-medium text-text-strong">{stage()}</div>
            <Show when={progress()}>{(value) => <div class="mt-1 text-12-regular text-text-weak">{value()}</div>}</Show>
          </div>
          <Show when={props.meta?.slow}>
            <div class="mt-3 rounded-lg border border-border-warning-base/40 bg-surface-warning-base/10 px-3 py-2 text-12-regular leading-5 text-text-warning-base">
              {language.t("config.skills.market.loading.slow")}
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

function SkillMarketProjectInstallMenu(props: {
  item: SkillMarketItem
  targets: SkillMarketProjectTarget[]
  installing: string
  installed: (item: SkillMarketItem, scope: SkillMarketInstallScope, target?: SkillMarketProjectTarget) => boolean
  busy: (item: SkillMarketItem, scope: SkillMarketInstallScope, target?: SkillMarketProjectTarget) => boolean
  onInstall: (item: SkillMarketItem, scope: SkillMarketInstallScope, target?: SkillMarketProjectTarget) => void
}) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const anyProjectBusy = () => props.installing.startsWith("project:") && props.installing.endsWith(props.item.id)
  const allProjectsInstalled = () =>
    props.targets.length > 0 && props.targets.every((target) => props.installed(props.item, "project", target))
  const label = () => {
    if (anyProjectBusy()) return language.t("config.skills.market.installing")
    if (allProjectsInstalled()) return language.t("config.skills.market.installed")
    return language.t("config.skills.market.installProject")
  }
  return (
    <DropdownMenu open={open()} onOpenChange={setOpen} placement="right-start" gutter={6}>
      <DropdownMenu.Trigger
        as={Button}
        size="small"
        variant="secondary"
        disabled={props.targets.length === 0 || !!props.installing || allProjectsInstalled()}
      >
        {label()}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="min-w-64">
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel>{language.t("config.skills.market.projects")}</DropdownMenu.GroupLabel>
            <For each={props.targets}>
              {(target) => (
                <DropdownMenu.Item
                  disabled={!!props.installing || props.installed(props.item, "project", target)}
                  onSelect={() => {
                    props.onInstall(props.item, "project", target)
                    setOpen(false)
                  }}
                >
                  <DropdownMenu.ItemLabel>{target.label}</DropdownMenu.ItemLabel>
                  <DropdownMenu.ItemDescription>
                    {props.busy(props.item, "project", target)
                      ? language.t("config.skills.market.installing")
                      : props.installed(props.item, "project", target)
                        ? language.t("config.skills.market.installed")
                        : target.root}
                  </DropdownMenu.ItemDescription>
                </DropdownMenu.Item>
              )}
            </For>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

function fuzzyTermScore(term: string, target: string): number {
  if (!target) return 0
  let qi = 0
  let score = 0
  let streak = 0
  for (let ti = 0; ti < target.length && qi < term.length; ti++) {
    if (target[ti] === term[qi]) {
      qi++
      streak++
      score += streak * 4
    } else {
      streak = 0
      score -= 1
    }
  }
  return qi === term.length ? score : 0
}

function fuzzySearchScore(query: string, target: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return 1
  const t = target.toLowerCase()
  let total = 0
  for (const term of terms) {
    const score = fuzzyTermScore(term, t)
    if (score <= 0) return 0
    total += score
  }
  return total / terms.length
}

function SkillMarket(props: {
  repos: SkillMarketRepo[]
  selected: string
  skills: SkillMarketItem[]
  loading: boolean
  loadMeta?: SkillMarketLoadMeta
  error?: unknown
  installing: string
  installedGlobal: Set<string>
  projectTargets: SkillMarketProjectTarget[]
  globalRoot?: string
  customValue: string
  customError: string
  onSelect: (id: string) => void
  onInstall: (item: SkillMarketItem, scope: SkillMarketInstallScope, target?: SkillMarketProjectTarget) => void
  onReload: () => void
  onCustomInput: (value: string) => void
  onCustomSubmit: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const platform = usePlatform()
  const [marketQuery, setMarketQuery] = createSignal("")
  const filteredSkills = createMemo(() => {
    const query = marketQuery()
    if (!query.trim()) return props.skills
    return props.skills
      .map((item) => {
        const score = Math.max(
          fuzzySearchScore(query, item.name) * 2,
          fuzzySearchScore(query, item.description),
          fuzzySearchScore(query, item.path),
          fuzzySearchScore(query, item.repoLabel),
        )
        return score > 0 ? { item, score } : undefined
      })
      .filter((entry): entry is { item: SkillMarketItem; score: number } => !!entry)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item)
  })
  const selectedRepo = () => props.repos.find((item) => item.id === props.selected)
  const errorText = () => {
    const err = props.error
    if (!err) return ""
    return err instanceof Error ? err.message : String(err)
  }
  const installed = (item: SkillMarketItem, scope: SkillMarketInstallScope, target?: SkillMarketProjectTarget) => {
    const folder = item.folder.toLowerCase()
    if (scope === "global") return props.installedGlobal.has(folder)
    if (target) return target.installed.has(folder)
    return props.projectTargets.some((project) => project.installed.has(folder))
  }
  const installKey = (item: SkillMarketItem, scope: SkillMarketInstallScope, target?: SkillMarketProjectTarget) =>
    `${scope}:${scope === "project" ? `${target?.root ?? ""}:` : ""}${item.id}`
  const busy = (item: SkillMarketItem, scope: SkillMarketInstallScope, target?: SkillMarketProjectTarget) =>
    props.installing === installKey(item, scope, target)
  const marketDescription = () => {
    const root = props.globalRoot?.trim()
    if (!root) return language.t("config.skills.market.description")
    return language.t("config.skills.market.descriptionWithRoot", { root })
  }
  const installLabel = (item: SkillMarketItem, scope: SkillMarketInstallScope, target?: SkillMarketProjectTarget) => {
    if (busy(item, scope, target)) return language.t("config.skills.market.installing")
    if (installed(item, scope, target)) return language.t("config.skills.market.installed")
    return scope === "global"
      ? language.t("config.skills.market.installGlobal")
      : language.t("config.skills.market.installProject")
  }
  const installDisabled = (
    item: SkillMarketItem,
    scope: SkillMarketInstallScope,
    target?: SkillMarketProjectTarget,
  ) => {
    const available = scope === "global" ? !!props.globalRoot : !!target
    return !available || !!props.installing || installed(item, scope, target)
  }
  const openDetail = (item: SkillMarketItem) => {
    const repo = props.repos.find((entry) => entry.repo === item.repo)
    const body = markdownBody(item.content)
    dialog.show(
      () => (
        <Dialog
          title={<span class="text-20-medium font-semibold text-text-strong">{item.name}</span>}
          description={item.repoLabel}
          class="w-full mx-auto"
          containerStyle={{
            width: "min(calc(100vw - 32px), 1080px)",
            transition: "width 180ms cubic-bezier(0.16, 1, 0.3, 1)",
          }}
          fit
          transition
        >
          <div class="flex flex-col gap-4 p-4 sm:p-5">
            <div class="rounded-xl border border-border-weak-base bg-background-base p-4">
              <div class="whitespace-pre-wrap break-words text-13-regular leading-6 text-text-base">
                {item.description}
              </div>
            </div>
            <div class="config-scrollbar max-h-[56vh] overflow-auto rounded-xl border border-border-weak-base bg-background-base p-4">
              <Markdown
                text={body || item.content.trim()}
                cacheKey={`skill-market-preview:${item.id}`}
                math="full"
                highlight="defer"
                class="text-13-regular"
              />
            </div>
            <div class="flex flex-wrap items-center justify-end gap-2">
              <Button
                size="small"
                variant="ghost"
                disabled={!repo?.url}
                onClick={() => repo?.url && platform.openLink(repo.url)}
              >
                {language.t("config.skills.market.openRepo")}
              </Button>
              <Button
                size="small"
                variant="secondary"
                disabled={installDisabled(item, "global")}
                onClick={() => props.onInstall(item, "global")}
              >
                {installLabel(item, "global")}
              </Button>
              <SkillMarketProjectInstallMenu
                item={item}
                targets={props.projectTargets}
                installing={props.installing}
                installed={installed}
                busy={busy}
                onInstall={props.onInstall}
              />
            </div>
          </div>
        </Dialog>
      ),
      undefined,
      { modal: true, preventScroll: true },
    )
  }

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="border-b border-border-weak-base px-5 py-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <div class="truncate text-20-medium text-text-strong">{language.t("config.skills.market.title")}</div>
              <span class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
                {language.t("config.skills.market.badge")}
              </span>
            </div>
            <div class="mt-1 text-12-regular text-text-weak">{marketDescription()}</div>
          </div>
          <Button
            size="small"
            variant="ghost"
            icon="refresh"
            class="h-8 rounded-lg border border-border-weak-base bg-background-base px-2.5 pr-3 text-12-medium text-text-base shadow-none transition-colors hover:border-border-strong hover:bg-surface-base-hover active:border-border-base active:bg-surface-base-active focus-visible:border-border-strong focus-visible:bg-surface-base-hover disabled:border-border-weak-base disabled:bg-background-base disabled:text-text-weaker"
            disabled={props.loading}
            onClick={props.onReload}
          >
            {language.t("config.skills.market.reload")}
          </Button>
        </div>
      </div>
      <div class="flex min-h-0 flex-1 gap-4 px-5 py-4">
        <div class="flex w-[320px] shrink-0 min-h-0 flex-col gap-3">
          <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
            {language.t("config.skills.market.repositories")}
          </div>
          <div class="rounded-xl border border-border-weak-base bg-background-base p-3">
            <div class="text-13-medium text-text-strong">{language.t("config.skills.market.custom.title")}</div>
            <div class="mt-2">
              <TextField
                type="text"
                hideLabel
                label={language.t("config.skills.market.custom.field")}
                description={language.t("config.skills.market.custom.inputDescription")}
                placeholder={language.t("config.skills.market.custom.placeholder")}
                value={props.customValue}
                validationState={props.customError ? "invalid" : undefined}
                error={props.customError}
                disabled={props.loading}
                onChange={props.onCustomInput}
                onKeyDown={(event: KeyboardEvent) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  props.onCustomSubmit()
                }}
              />
            </div>
            <div class="mt-3">
              <Button
                size="small"
                variant="secondary"
                disabled={props.loading || !props.customValue.trim()}
                onClick={props.onCustomSubmit}
              >
                {language.t("config.skills.market.custom.load")}
              </Button>
            </div>
          </div>
          <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
            <div class="flex flex-col gap-2">
              <For each={props.repos}>
                {(repo) => (
                  <div
                    class="rounded-xl border px-3 py-3 text-left transition-colors"
                    classList={{
                      "border-border-base bg-surface-base-active": props.selected === repo.id,
                      "border-border-weak-base bg-background-base hover:border-border-strong hover:bg-surface-base-hover":
                        props.selected !== repo.id,
                    }}
                  >
                    <div class="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        class="min-w-0 flex-1 text-left"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          props.onSelect(repo.id)
                        }}
                      >
                        <div class="truncate text-13-medium text-text-strong">{repo.label}</div>
                        <div class="mt-1 line-clamp-2 text-12-regular text-text-weak">{repo.description}</div>
                        <div class="mt-2 break-all font-mono text-[11px] leading-5 text-text-weak">{repo.repo}</div>
                      </button>
                      <button
                        type="button"
                        class="shrink-0 text-text-weak transition-colors hover:text-text-base"
                        aria-label={language.t("config.skills.market.openRepo")}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          platform.openLink(repo.url)
                        }}
                      >
                        <Icon name="link" size="small" />
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                {selectedRepo()?.label ?? language.t("config.skills.market.skills")}
              </div>
            </div>
            <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
              {filteredSkills().length}
            </div>
          </div>

          <div class="mb-3 flex h-8 items-center gap-2 rounded-lg border border-border-weak-base bg-surface-base px-3">
            <Icon name="magnifying-glass" class="shrink-0 text-icon-weak-base" />
            <input
              type="text"
              value={marketQuery()}
              onInput={(event) => setMarketQuery(event.currentTarget.value)}
              placeholder={language.t("config.skills.market.search.placeholder")}
              class="min-w-0 flex-1 bg-transparent text-13-regular text-text-base outline-none placeholder:text-text-weak"
            />
            <Show when={marketQuery()}>
              <IconButton
                icon="close-small"
                variant="ghost"
                class="size-5 rounded"
                onClick={() => setMarketQuery("")}
              />
            </Show>
          </div>

          <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto">
            <Show when={!props.loading} fallback={<SkillMarketLoading meta={props.loadMeta} />}>
              <Show
                when={!errorText()}
                fallback={
                  <div class="rounded-xl border border-border-danger-base/50 bg-surface-danger-base/10 p-4">
                    <div class="text-13-medium text-text-danger-base">
                      {language.t("config.skills.market.loadFailed")}
                    </div>
                    <div class="mt-2 break-all text-12-regular text-text-weak">{errorText()}</div>
                    <div class="mt-3">
                      <Button size="small" variant="secondary" onClick={props.onReload}>
                        {language.t("config.skills.market.reload")}
                      </Button>
                    </div>
                  </div>
                }
              >
                <Show
                  when={filteredSkills().length > 0}
                  fallback={
                    <div class="rounded-xl border border-border-weak-base bg-background-base p-4 text-13-regular text-text-weak">
                      {props.skills.length > 0
                        ? language.t("config.skills.market.search.noResults")
                        : language.t("config.skills.market.empty")}
                    </div>
                  }
                >
                  <div class="grid gap-3 lg:grid-cols-2">
                    <For each={filteredSkills()}>
                      {(item) => {
                        const isInstalled = () => installed(item, "global") || installed(item, "project")
                        return (
                          <div
                            class="group relative flex min-h-[180px] flex-col overflow-hidden rounded-xl border border-border-weak-base bg-background-base p-4 text-left transition-all duration-150 ease-out hover:-translate-y-0.5 hover:border-border-strong hover:bg-surface-base-hover hover:shadow-[0_10px_28px_-12px_color-mix(in_srgb,var(--border-strong-base)_55%,transparent)] focus:outline-none focus-visible:border-border-strong focus-visible:bg-surface-base-hover"
                            role="button"
                            tabindex="0"
                            onClick={() => openDetail(item)}
                            onKeyDown={(event: KeyboardEvent) => {
                              if (event.key !== "Enter" && event.key !== " ") return
                              event.preventDefault()
                              openDetail(item)
                            }}
                          >
                            <div class="pointer-events-none absolute inset-0 rounded-[inherit]">
                              <div class="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--surface-brand-base)_60%,transparent),transparent)] opacity-40 transition-opacity duration-150 group-hover:opacity-100" />
                              <div class="absolute -right-8 -top-10 size-28 rounded-full bg-[radial-gradient(circle_at_center,color-mix(in_srgb,var(--surface-brand-base)_22%,transparent),transparent_70%)] opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
                              <div class="absolute inset-0 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--surface-brand-base)_9%,transparent),transparent_55%)] opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
                            </div>
                            <div class="relative flex min-w-0 items-start justify-between gap-3">
                              <div class="flex min-w-0 items-start gap-2.5">
                                <div class="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-border-weak-base bg-[linear-gradient(135deg,color-mix(in_srgb,var(--surface-brand-base)_88%,var(--background-base)),color-mix(in_srgb,var(--surface-brand-hover)_60%,transparent))] text-14-medium text-text-on-brand-strong shadow-sm transition-[transform] duration-150 ease-out group-hover:-rotate-3 group-hover:scale-105">
                                  {item.name.charAt(0).toUpperCase()}
                                </div>
                                <div class="min-w-0">
                                  <div class="flex min-w-0 items-center gap-1.5">
                                    <div class="truncate text-14-medium text-text-strong">{item.name}</div>
                                    <Icon
                                      name="arrow-right"
                                      size="small"
                                      class="shrink-0 text-icon-brand-base opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover:translate-x-0.5 group-hover:opacity-100"
                                    />
                                  </div>
                                  <div class="mt-1 line-clamp-3 text-12-regular text-text-weak">{item.description}</div>
                                </div>
                              </div>
                              <Show when={isInstalled()}>
                                <span class="flex shrink-0 items-center gap-1 rounded-full bg-surface-success-base px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-on-success-base">
                                  <Icon name="check-small" size="small" />
                                  {language.t("config.skills.market.installed")}
                                </span>
                              </Show>
                            </div>
                            <div class="relative mt-3 break-all font-mono text-[11px] leading-5 text-text-weak">
                              {item.path}
                            </div>
                            <div class="relative mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
                              <div class="flex items-center gap-1.5 text-[11px] text-text-weak">
                                <Icon name="github" size="small" class="text-icon-weak-base" />
                                <span>{item.repoLabel}</span>
                              </div>
                              <div class="flex flex-wrap items-center justify-end gap-2">
                                <Button
                                  size="small"
                                  variant="secondary"
                                  disabled={installDisabled(item, "global")}
                                  onClick={(event: MouseEvent) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    props.onInstall(item, "global")
                                  }}
                                >
                                  {installLabel(item, "global")}
                                </Button>
                                <div
                                  onClick={(event) => event.stopPropagation()}
                                  onKeyDown={(event) => event.stopPropagation()}
                                >
                                  <SkillMarketProjectInstallMenu
                                    item={item}
                                    targets={props.projectTargets}
                                    installing={props.installing}
                                    installed={installed}
                                    busy={busy}
                                    onInstall={props.onInstall}
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
