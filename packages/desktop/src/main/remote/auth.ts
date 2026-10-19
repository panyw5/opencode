import { randomBytes } from "node:crypto"
import type { RemoteDevice } from "@opencode-ai/app/remote/types"
import { digest, equal } from "./security"

export type { RemoteDevice }
export type RemoteAuthSnapshot = { version: 1; devices: Array<RemoteDevice & { tokenHash: string }> }
type AuthRecord = RemoteDevice & { tokenHash: string }
type Pairing = { expiresAt: number }

const DEVICE_TTL_MS = 30 * 24 * 60 * 60_000
const MAX_DEVICES = 32
const MAX_PAIRINGS = 16
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000

export class RemoteAuth {
  private readonly records = new Map<string, AuthRecord>()
  private readonly pairings = new Map<string, Pairing>()
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly save: (snapshot: RemoteAuthSnapshot) => Promise<void>,
    initial?: RemoteAuthSnapshot,
    private readonly now = () => Date.now(),
  ) {
    if (initial?.version === 1 && Array.isArray(initial.devices)) {
      for (const input of initial.devices.slice(0, MAX_DEVICES)) {
        const record = validateRecord(input, this.now())
        if (record && !this.records.has(record.id)) this.records.set(record.id, record)
      }
    }
    if (initial && (!Array.isArray(initial.devices) || initial.devices.length !== this.records.size))
      void this.persist().catch(() => {})
  }

  createPairing(): { code: string; expiresAt: number } {
    this.removeExpired()
    if (this.records.size >= MAX_DEVICES) throw new Error("Remote device limit reached")
    while (this.pairings.size >= MAX_PAIRINGS) this.pairings.delete(this.pairings.keys().next().value!)
    const code = randomBytes(32).toString("hex")
    const expiresAt = this.now() + 5 * 60_000
    this.pairings.set(digest(code), { expiresAt })
    return { code, expiresAt }
  }

  async redeem(code: string, name: unknown): Promise<{ token: string; device: RemoteDevice } | undefined> {
    if (!/^[a-f0-9]{64}$/.test(code)) return
    this.removeExpired()
    if (this.records.size >= MAX_DEVICES) return
    const key = digest(code)
    const pairing = this.pairings.get(key)
    if (!pairing || pairing.expiresAt <= this.now()) {
      this.pairings.delete(key)
      return
    }
    this.pairings.delete(key)
    const token = randomBytes(32).toString("hex")
    const timestamp = this.now()
    const device: RemoteDevice = {
      id: randomBytes(16).toString("hex"),
      name: cleanName(name),
      createdAt: timestamp,
      lastSeenAt: timestamp,
      expiresAt: timestamp + DEVICE_TTL_MS,
    }
    const record: AuthRecord = { ...device, tokenHash: digest(token) }
    this.records.set(device.id, record)
    try {
      await this.persist()
    } catch {
      if (this.records.get(device.id)?.tokenHash === record.tokenHash) this.records.delete(device.id)
      await this.persist().catch(() => {})
      return
    }
    if (this.records.get(device.id)?.tokenHash !== record.tokenHash) return
    return { token, device: { ...device } }
  }

  authenticate(token: string | undefined): RemoteDevice | undefined {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return
    const hash = digest(token)
    for (const record of this.records.values()) {
      if (!equal(hash, record.tokenHash)) continue
      const now = this.now()
      if (record.expiresAt <= now) {
        this.records.delete(record.id)
        void this.persist().catch(() => {})
        return
      }
      if (now - record.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
        record.lastSeenAt = now
        void this.persist().catch(() => {})
      }
      const { tokenHash: _tokenHash, ...device } = record
      return { ...device }
    }
  }

  async revoke(id: string): Promise<void> {
    this.records.delete(id)
    await this.persist()
  }

  async reset(): Promise<void> {
    this.records.clear()
    this.pairings.clear()
    await this.persist()
  }

  devices(): RemoteDevice[] {
    this.removeExpired()
    return [...this.records.values()].map(({ tokenHash: _tokenHash, ...device }) => ({ ...device }))
  }

  private removeExpired(): void {
    const now = this.now()
    for (const [key, pairing] of this.pairings) if (pairing.expiresAt <= now) this.pairings.delete(key)
    let changed = false
    for (const [id, record] of this.records) {
      if (record.expiresAt > now) continue
      this.records.delete(id)
      changed = true
    }
    if (changed) void this.persist().catch(() => {})
  }

  private persist(): Promise<void> {
    const snapshot: RemoteAuthSnapshot = {
      version: 1,
      devices: [...this.records.values()].map((record) => ({ ...record })),
    }
    const next = this.writes.then(() => this.save(snapshot))
    this.writes = next.catch(() => {})
    return next
  }
}

function validateRecord(value: unknown, now: number): AuthRecord | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Partial<AuthRecord>
  if (
    typeof input.id !== "string" ||
    !/^[a-f0-9]{32}$/.test(input.id) ||
    typeof input.tokenHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.tokenHash) ||
    !Number.isFinite(input.createdAt) ||
    !Number.isFinite(input.lastSeenAt) ||
    !Number.isFinite(input.expiresAt) ||
    typeof input.name !== "string"
  )
    return
  const createdAt = input.createdAt!
  const lastSeenAt = input.lastSeenAt!
  const expiresAt = input.expiresAt!
  if (
    createdAt <= 0 ||
    createdAt > now + 5 * 60_000 ||
    lastSeenAt < createdAt ||
    lastSeenAt > now + 5 * 60_000 ||
    expiresAt <= now ||
    expiresAt > createdAt + DEVICE_TTL_MS ||
    expiresAt <= createdAt ||
    lastSeenAt > expiresAt
  )
    return
  return {
    id: input.id,
    name: cleanName(input.name),
    createdAt,
    lastSeenAt,
    expiresAt,
    tokenHash: input.tokenHash,
  }
}

function cleanName(value: unknown): string {
  if (typeof value !== "string") return "Mobile device"
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 80)
  return name || "Mobile device"
}
