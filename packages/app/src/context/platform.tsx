import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import { ServerConnection } from "./server"
import type { WslServersPlatform } from "../wsl/types"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenFilePickerOptions = { title?: string; multiple?: boolean; accept?: string[]; extensions?: string[] }
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type UpdateInfo = { updateAvailable: boolean; version?: string }

export type ConfigFile = {
  id: string
  label: string
  path: string
  exists: boolean
  scope: string
  kind: string
}

export type ConfigWorkspaceFile = {
  name: string
  path: string
  kind: string
}

export type ConfigWorkspace = {
  configRoot?: string
  agentsRoot?: string
  skillsRoot?: string
  pluginsRoot?: string
  agentsMdPath?: string
  agents: ConfigWorkspaceFile[]
  plugins: ConfigWorkspaceFile[]
}

export type ConfigTreeItem = {
  path: string
  kind: "file" | "directory"
}

export type OpenclawConfig = {
  enabled: boolean
  url?: string
  token?: string
}

export type OpenclawServer = {
  url: string
  username?: string
  password?: string
}

export type OpenclawTest = {
  ok: boolean
  logs: string[]
}

export type OpenclawDetection = {
  ok: boolean
  config?: OpenclawConfig
  source?: string
  logs: string[]
}

export type GenericagentConfig = {
  enabled: boolean
  pythonExecutable?: string
  genericAgentDir?: string
}

export type GenericagentServer = {
  url: string
  username?: string
  password?: string
}

export type GenericagentTest = {
  ok: boolean
  logs: string[]
}

export type HermesConfig = {
  enabled: boolean
  pythonExecutable?: string
  hermesDir?: string
  hermesHome?: string
}

export type HermesServer = {
  url: string
  username?: string
  password?: string
}

export type HermesTest = {
  ok: boolean
  logs: string[]
}

export type CliAgentID = "codex" | "claude" | "grok" | "dsh"

export type CliAgentConfig = {
  enabled: boolean
  binaryPath?: string
  configHome?: string
}

export type DshHomeConfig = {
  home: string
  settingsPath: string
  credentialsPath: string
  selection: { provider: string; model: string; baseURL?: string }
  hasFileApiKey: boolean
  apiKeyEnvSet: boolean
  baseUrlEnvSet: boolean
  settingsExists: boolean
  credentialsExists: boolean
}

export type DshHomeUpdate = {
  provider?: string
  model?: string
  baseURL?: string
  apiKey?: string
  clearApiKey?: boolean
}

export type DshPluginEntry = {
  id: string
  name?: string
  source?: string
  disabled?: boolean | string
  configPreview?: string
}

export type DshPluginInventory = {
  profile: string
  checkedAt: number
  binaryPath?: string
  plugins: DshPluginEntry[]
  sources: string[]
  error?: string
}

export type CliAgentTest = {
  ok: boolean
  logs: string[]
}

export type CliAgentDetail = {
  label: string
  value: string
}

export type CliAgentInfo = {
  sourceUrl: string
  installed: boolean
  binaryPath?: string
  version?: string
  configHome?: string
  configPath?: string
  configExists?: boolean
  details?: CliAgentDetail[]
  checkedAt?: number
  error?: string
  dsh?: {
    provider: string
    model: string
    baseURL: string
    hasFileApiKey: boolean
    apiKeyEnvSet: boolean
    baseUrlEnvSet: boolean
    settingsPath: string
    credentialsPath: string
  }
}

export type CliAgentDescriptor = {
  id: CliAgentID
  label: string
  command: string
  sourceUrl: string
  configHomeLabel: string
  configHomePlaceholder: string
}

export type CliAgents = {
  list(): Promise<CliAgentDescriptor[]>
  get(id: CliAgentID): Promise<CliAgentConfig>
  set(id: CliAgentID, config: CliAgentConfig): Promise<void> | void
  test(id: CliAgentID, config: CliAgentConfig): Promise<CliAgentTest>
  info(id: CliAgentID, config?: CliAgentConfig): Promise<CliAgentInfo>
  getDshHome?(config?: CliAgentConfig): Promise<DshHomeConfig>
  setDshHome?(config: CliAgentConfig, update: DshHomeUpdate): Promise<DshHomeConfig>
  getDshApiKey?(config?: CliAgentConfig): Promise<string | undefined>
  listDshPlugins?(config?: CliAgentConfig, profile?: string): Promise<DshPluginInventory>
  setDshPluginEnabled?(
    config: CliAgentConfig | undefined,
    input: { profile?: string; id: string; enabled: boolean },
  ): Promise<DshPluginInventory>
}

export type ExtraAgentId = "openclaw" | "hermes" | "genericagent"

export type ExtraAgentInfo = {
  id: ExtraAgentId
  sourceUrl: string
  localPath?: string
  localVersion?: string
  localCommit?: string
  localBranch?: string
  latestVersion?: string
  latestCommit?: string
  latestBranch?: string
  updateAvailable?: boolean
  checkedAt?: number
  error?: string
}

export type Platform = {
  /** Platform discriminator */
  platform: "web" | "desktop"

  /** Desktop OS (Tauri only) */
  os?: "macos" | "windows" | "linux"

  /** App version */
  version?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Open folder in Finder/Explorer (desktop only) */
  openInFinder?(path: string): Promise<void>

  /** Open folder in VSCode (desktop only) */
  openInVscode?(path: string): Promise<void>

  /** Open folder in specified editor (desktop only) */
  openInEditor?(editor: string, path: string): Promise<void>

  /** Get custom editor path (desktop only) */
  getCustomEditorPath?(): Promise<string | null>

  /** Set custom editor path (desktop only) */
  setCustomEditorPath?(path: string | null): Promise<void>

  /** Get default editor (desktop only) */
  getDefaultEditor?(): Promise<string | null>

  /** Set default editor (desktop only) */
  setDefaultEditor?(editor: string | null): Promise<void>

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Restart the app  */
  restart(): Promise<void>

  /** Reload the local backend without relaunching the app (desktop only) */
  reloadBackend?(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string): Promise<void>

  /** Open directory picker dialog (native on Tauri, server-backed on web) */
  openDirectoryPickerDialog?(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>

  /** Open native file picker dialog (Tauri only) */
  openFilePickerDialog?(opts?: OpenFilePickerOptions): Promise<PickerPaths>

  /** Save file picker dialog (Tauri only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Check for updates (Tauri only) */
  checkUpdate?(): Promise<UpdateInfo>

  /** Install updates (Tauri only) */
  update?(): Promise<void>

  /** Install pending update and relaunch (desktop only) */
  updateAndRestart?(): Promise<void>

  /** Export bundled debug log archive path (desktop only) */
  exportDebugLogs?(): Promise<string>

  /** Forward a fatal renderer error to the main process for logging (desktop only) */
  recordFatalRendererError?(error: {
    error: string
    url: string
    version?: string
    platform: string
    os?: string
  }): Promise<void> | void

  /** Fetch override */
  fetch?: typeof fetch

  /** Fetch for external APIs — bypasses loopback routing, always uses native HTTP (Tauri only) */
  fetchExternal?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Get the configured WSL integration (desktop only) */
  getWslEnabled?(): Promise<boolean>

  /** Set the configured WSL integration (desktop only) */
  setWslEnabled?(config: boolean): Promise<void> | void

  /** WSL multi-server management API (Windows desktop only) */
  wslServers?: WslServersPlatform

  /** Get the configured OpenClaw integration (desktop only) */
  getOpenclawConfig?(): Promise<OpenclawConfig>

  /** Set the configured OpenClaw integration (desktop only) */
  setOpenclawConfig?(config: OpenclawConfig): Promise<void> | void

  /** Save and test the configured OpenClaw integration (desktop only) */
  testOpenclawConfig?(config: OpenclawConfig): Promise<OpenclawTest>

  /** Detect local OpenClaw gateway settings (desktop only) */
  detectOpenclawConfig?(): Promise<OpenclawDetection>

  /** Abort a running OpenClaw connection test (desktop only) */
  abortOpenclawTest?(): Promise<boolean>

  /** Get the configured Hermes integration (desktop only) */
  getHermesConfig?(): Promise<HermesConfig>

  /** Set the configured Hermes integration (desktop only) */
  setHermesConfig?(config: HermesConfig): Promise<void> | void

  /** Save and test the configured Hermes integration (desktop only) */
  testHermesConfig?(config: HermesConfig): Promise<HermesTest>

  /** Abort a running Hermes connection test (desktop only) */
  abortHermesTest?(): Promise<boolean>

  /** Local CLI-backed agents exposed by the desktop process. */
  cliAgents?: CliAgents

  /** Get the configured GenericAgent integration (desktop only) */
  getGenericagentConfig?(): Promise<GenericagentConfig>

  /** Set the configured GenericAgent integration (desktop only) */
  setGenericagentConfig?(config: GenericagentConfig): Promise<void> | void

  /** Save and test the configured GenericAgent integration (desktop only) */
  testGenericagentConfig?(config: GenericagentConfig): Promise<GenericagentTest>

  /** Abort a running GenericAgent connection test (desktop only) */
  abortGenericagentTest?(): Promise<boolean>

  /** Restart a running external agent connection (desktop only) */
  restartExtraAgent?(id: ExtraAgentId): Promise<void>

  /** Inspect installed version and upstream status for an external agent (desktop only) */
  getExtraAgentInfo?(
    id: ExtraAgentId,
    config?: OpenclawConfig | HermesConfig | GenericagentConfig,
  ): Promise<ExtraAgentInfo>

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Parse markdown to HTML using native parser (desktop only, returns unprocessed code blocks) */
  parseMarkdown?(markdown: string): Promise<string>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Get pinch-zoom enabled flag (desktop only) */
  getPinchZoomEnabled?(): Promise<boolean>

  /** Set pinch-zoom enabled flag (desktop only) */
  setPinchZoomEnabled?(enabled: boolean): Promise<void>

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Filter paths to return only directories (desktop only) */
  filterDirectories?(paths: string[]): Promise<string[]>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Search for text in the current page (desktop only) */
  find?(query: string, dir?: 1 | -1): Promise<boolean | void>

  /** List known config files (desktop only) */
  listConfigFiles?(directory?: string | null): Promise<ConfigFile[]>

  /** Read config file text (desktop only) */
  readConfigFile?(path: string): Promise<string | null>

  /** Write config file text (desktop only) */
  writeConfigFile?(path: string, content: string): Promise<void>

  /** Create a config file and fail if it already exists (desktop only) */
  createConfigFile?(path: string, content: string): Promise<void>

  /** Delete a config file (desktop only) */
  deleteConfigFile?(path: string): Promise<void>

  /** Rename (move) a config file from oldPath to newPath (desktop only) */
  renameConfigFile?(oldPath: string, newPath: string): Promise<void>

  /** Create a project-scoped temporary text attachment file (desktop only) */
  createTempMarkdownAttachment?(directory: string, content: string, extension?: string): Promise<string>

  /** Inspect global config workspace (desktop only) */
  getConfigWorkspace?(): Promise<ConfigWorkspace>

  /** List config directory tree (desktop only) */
  listConfigDirectory?(path: string): Promise<ConfigTreeItem[]>

  /** List a local directory without bootstrapping an opencode workspace (desktop only) */
  listLocalDirectory?(path: string): Promise<ConfigTreeItem[]>

  /** Invoke a desktop menu action handler (desktop only) */
  runDesktopMenuAction?(action: import("@/desktop-menu").DesktopMenuAction): Promise<void> | void
}

export type DisplayBackend = "auto" | "wayland"

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
