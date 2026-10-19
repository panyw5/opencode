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
}

export type RemoteDevice = {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
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
