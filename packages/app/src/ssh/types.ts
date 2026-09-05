export type SshServerConfig = {
  id: string
  target: string
  autoStart: boolean
}

export type SshServerRuntime =
  | { kind: "starting" }
  | { kind: "ready"; url: string; username: string | null; password: string | null }
  | { kind: "failed"; message: string }
  | { kind: "stopped" }

export type SshServerItem = {
  config: SshServerConfig
  runtime: SshServerRuntime
}

export type SshHostProbe = {
  target: string
  reachable: boolean
  error: string | null
}

export type SshOpencodeCheck = {
  target: string
  resolvedPath: string | null
  version: string | null
  expectedVersion: string | null
  matchesDesktop: boolean | null
  error: string | null
}

export type SshJob =
  | { kind: "probe"; target: string; startedAt: number }
  | { kind: "probe-opencode"; target: string; startedAt: number }
  | { kind: "install-opencode"; target: string; startedAt: number }

export type SshServersState = {
  probes: Record<string, SshHostProbe>
  opencodeChecks: Record<string, SshOpencodeCheck>
  servers: SshServerItem[]
  job: SshJob | null
}

export type SshServersEvent = { type: "state"; state: SshServersState }

export type SshDirectoryEntry = {
  path: string
  kind: "directory" | "file"
}

export type SshServersPlatform = {
  getState(): Promise<SshServersState>
  subscribe(cb: (event: SshServersEvent) => void): () => void
  probeHost(target: string): Promise<void>
  probeOpencode(target: string): Promise<void>
  installOpencode(target: string): Promise<void>
  addServer(target: string, autoStart?: boolean): Promise<SshServerConfig>
  removeServer(id: string): Promise<void>
  startServer(id: string): Promise<void>
  listRemoteDirectory(target: string, path: string): Promise<SshDirectoryEntry[]>
  validateRemoteDirectory(target: string, path: string): Promise<string | null>
}
