export type RemoteAccessPhase =
  | "disabled"
  | "starting"
  | "connecting"
  | "online"
  | "reconnecting"
  | "error"
  | "stopping"

export type RemoteAccessStatus = {
  enabled: boolean
  phase: RemoteAccessPhase
  url?: string
  error?: string
  stage?: "registering" | "waiting-certificate" | "connecting-relay"
  startedAt?: number
  stageStartedAt?: number
}

export type RemoteDevice = {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  connection?: {
    state: "active" | "background" | "offline" | "unknown"
    lastActivityAt?: number
    pages: Array<RemotePage & { visible: boolean; updatedAt: number }>
  }
}

export type RemotePage = {
  kind: "home" | "session" | "project-tasks" | "scheduled-tasks" | "settings" | "config" | "workspace" | "other"
  project?: string
  sessionID?: string
}

export type RemotePairing = {
  url: string
  expiresAt: number
}

export type RemoteAccessApi = {
  status(): Promise<RemoteAccessStatus>
  enable(): Promise<RemoteAccessStatus>
  disable(): Promise<RemoteAccessStatus>
  pair(): Promise<RemotePairing>
  devices(): Promise<RemoteDevice[]>
  revoke(id: string): Promise<void>
  reset(): Promise<RemoteAccessStatus>
  onStatus(listener: (status: RemoteAccessStatus) => void): () => void
}
