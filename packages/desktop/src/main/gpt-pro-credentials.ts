import { app, safeStorage, session } from "electron"
import { join } from "node:path"
import { rm } from "node:fs/promises"
import { GPT_PRO_PARTITION, GPT_PRO_LEGACY_PARTITION } from "@opencode-ai/util/gpt-pro"
import { GptProCredentialVault, restorableGptProCookies } from "./gpt-pro-credential-vault"
import { gptProSessionCookieRevoked, restoreGptProCookieSnapshot, type SessionCookie } from "./gpt-pro-session-cookies"
import { GptProCredentialProfiles } from "./gpt-pro-credential-profiles"
import { createGptProCredentialReadiness } from "./gpt-pro-credential-readiness"
import { write as writeLog } from "./logging"
import { GptProOperationError } from "@opencode-ai/util/gpt-pro-error"
import type { GptProRuntimeStatus } from "@opencode-ai/util/gpt-pro"

const log = (message: string) => writeLog("gpt-pro", message)
let instance: ReturnType<typeof createCredentials> | undefined
export function getGptProCredentials() {
  return (instance ??= createCredentials())
}
export async function flushGptProCredentials() {
  await instance?.flush()
}

function createCredentials() {
  const vault = new GptProCredentialVault({
    path: join(app.getPath("userData"), "gpt-pro", "credentials.enc"),
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
    log,
  })
  let error: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let phase: GptProRuntimeStatus["credentials"]["phase"] = "unrestored"
  let initialized = false
  const listeners = new Set<() => void>()
  const sessionListeners = new Set<(profileID: string) => void>()
  const releasedListeners = new Set<(profileID: string) => void>()
  const changed = () => {
    for (const listener of listeners) listener()
  }
  const writeSnapshot = async (cookies: Electron.Cookie[]) => {
    try {
      await vault.write(cookies)
      error = undefined
      phase = "available"
      changed()
    } catch {
      error =
        "credential_storage: Secure persistence failed. Keep this app open and restore secure storage before restarting."
      log("credential-vault snapshot failed; in-memory session retained, plaintext fallback refused")
      phase = "storage_fault"
      changed()
      throw new GptProOperationError(
        "credential_storage",
        "Secure persistence failed. Keep this app open and restore secure storage before restarting.",
      )
    }
  }
  const profiles = new GptProCredentialProfiles({
    create: (id) => {
      const profile = session.fromPartition(id)
      const listener: Parameters<typeof profile.cookies.on>[1] = (_event, cookie, cause, removed) => {
        if (!initialized || !["chatgpt.com", ".chatgpt.com"].includes(cookie.domain ?? "")) return
        if (gptProSessionCookieRevoked(cookie.name, cause, removed))
          for (const listener of sessionListeners) listener(id)
        if (id !== profiles.profileID()) return
        clearTimeout(timer)
        timer = setTimeout(() => {
          void profiles.persist().catch(() => {})
        }, 200)
      }
      profile.cookies.on("changed", listener)
      return {
        cookies: profile.cookies,
        dispose: async () => {
          profile.cookies.removeListener("changed", listener)
          await profile.clearStorageData()
          await profile.closeAllConnections()
        },
      }
    },
    persist: writeSnapshot,
    changed,
    released: (id) => {
      for (const listener of releasedListeners) listener(id)
    },
    log,
  })
  const persist = () => profiles.persist()
  const initialize = async () => {
    phase = "restoring"
    changed()
    log("credential-vault initialization started; encrypted sources only")
    const restored = await vault.read()
    const legacy = session.fromPartition(GPT_PRO_LEGACY_PARTITION)
    const cookies =
      restored ??
      restorableGptProCookies(
        (await legacy.cookies.get({ domain: "chatgpt.com" })).filter((cookie) =>
          ["chatgpt.com", ".chatgpt.com"].includes(cookie.domain ?? ""),
        ),
      )
    if (!restored && cookies.length) {
      log(`credential-vault migration stage=encrypt count=${cookies.length}`)
      await vault.write(cookies)
    }
    await restoreGptProCookieSnapshot(profiles.jar(), cookies, log)
    // No page uses the legacy profile in this process. Remove its plaintext database only after the encrypted commit.
    await legacy.clearStorageData()
    await legacy.cookies.flushStore()
    await legacy.closeAllConnections()
    await rm(join(app.getPath("userData"), "Partitions", "consult-gpt-pro"), { recursive: true, force: true })
    log(
      `credential-vault ready encrypted=true memoryProfile=true restored=${cookies.length} legacyPlaintextRemoved=true`,
    )
    initialized = true
    phase = "available"
    error = undefined
    changed()
  }
  const initializationFailed = (cause: unknown): never => {
    error =
      "credential_storage: ChatGPT secure credential storage could not be initialized. Existing encrypted and legacy data were preserved when initialization failed."
    log("credential-vault initialization failed; refusing credential mutation and new dispatch")
    phase = "storage_fault"
    changed()
    throw cause
  }
  const readiness = createGptProCredentialReadiness({
    initialize,
    persist,
    initialized: () => initialized,
    initializationFailed,
  })
  return {
    async flush() {
      clearTimeout(timer)
      await readiness.ready()
      await persist()
    },
    ready: () =>
      readiness.ready().then(() => {
        if (error)
          throw new GptProOperationError(
            "credential_storage",
            "Secure credential persistence needs recovery. Restore system secure storage before sending or importing.",
          )
      }),
    status: (): GptProRuntimeStatus["credentials"] => ({ phase, ...(error ? { error } : {}) }),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    profileID: () => profiles.profileID(),
    onSessionChanged(listener: (profileID: string) => void) {
      sessionListeners.add(listener)
      return () => {
        sessionListeners.delete(listener)
      }
    },
    onProfileReleased(listener: (profileID: string) => void) {
      releasedListeners.add(listener)
      return () => {
        releasedListeners.delete(listener)
      }
    },
    recover() {
      log(`credential-vault explicit recovery initialized=${initialized}; no credentials logged`)
      return readiness.recover()
    },
    async stage(cookies: SessionCookie[]) {
      await readiness.ready()
      if (error)
        throw new GptProOperationError(
          "credential_storage",
          "Restore secure credential storage before importing a login.",
        )
      return profiles.stage(cookies)
    },
    async promote(id: string, commitExecution: () => void) {
      clearTimeout(timer)
      await profiles.promote(id, commitExecution)
    },
    retain: (id: string) => profiles.retain(id),
    collect: (retain: (id: string) => boolean) => profiles.collect(retain),
  }
}
