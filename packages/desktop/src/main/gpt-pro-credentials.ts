import { app, safeStorage, session } from "electron"
import { join } from "node:path"
import { rm } from "node:fs/promises"
import { GPT_PRO_PARTITION, GPT_PRO_LEGACY_PARTITION } from "@opencode-ai/util/gpt-pro"
import { GptProCredentialVault } from "./gpt-pro-credential-vault"
import { importSessionCookies, type SessionCookie } from "./gpt-pro-session-cookies"
import { write as writeLog } from "./logging"
import { GptProOperationError } from "@opencode-ai/util/gpt-pro-error"

const log = (message: string) => writeLog("gpt-pro", message)
let instance: ReturnType<typeof createCredentials> | undefined
export function getGptProCredentials() {
  return (instance ??= createCredentials())
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
  const profile = session.fromPartition(GPT_PRO_PARTITION)
  let mutating = false
  let error: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const snapshot = () =>
    profile.cookies
      .get({ domain: "chatgpt.com" })
      .then((cookies) => cookies.filter((cookie) => ["chatgpt.com", ".chatgpt.com"].includes(cookie.domain ?? "")))
  const persist = async () => {
    try {
      await vault.write(await snapshot())
      error = undefined
    } catch {
      error =
        "credential_storage: Secure persistence failed. Keep this app open and restore secure storage before restarting."
      log("credential-vault snapshot failed; in-memory session retained, plaintext fallback refused")
      throw new GptProOperationError(
        "credential_storage",
        "Secure persistence failed. Keep this app open and restore secure storage before restarting.",
      )
    }
  }
  const ready = (async () => {
    const restored = await vault.read()
    const legacy = session.fromPartition(GPT_PRO_LEGACY_PARTITION)
    const cookies =
      restored ??
      (await legacy.cookies.get({ domain: "chatgpt.com" })).filter((cookie) =>
        ["chatgpt.com", ".chatgpt.com"].includes(cookie.domain ?? ""),
      )
    if (!restored && cookies.length) {
      log(`credential-vault migration stage=encrypt count=${cookies.length}`)
      await vault.write(cookies)
    }
    for (const cookie of cookies)
      await profile.cookies.set({
        url: `https://chatgpt.com${cookie.path ?? "/"}`,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
        ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
      })
    // No page uses the legacy profile in this process. Remove its plaintext database only after the encrypted commit.
    await legacy.clearStorageData()
    await legacy.cookies.flushStore()
    await legacy.closeAllConnections()
    await rm(join(app.getPath("userData"), "Partitions", "consult-gpt-pro"), { recursive: true, force: true })
    log(
      `credential-vault ready encrypted=true memoryProfile=true restored=${cookies.length} legacyPlaintextRemoved=true`,
    )
    profile.cookies.on("changed", (_event, cookie) => {
      if (!["chatgpt.com", ".chatgpt.com"].includes(cookie.domain ?? "")) return
      if (mutating) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        void persist().catch(() => {})
      }, 200)
    })
  })().catch((cause) => {
    error =
      "credential_storage: ChatGPT secure credential storage could not be initialized. Existing encrypted and legacy data were preserved when initialization failed."
    log("credential-vault initialization failed; refusing credential mutation and new dispatch")
    throw cause
  })
  void ready.catch(() => {})
  let quitting = false
  app.on("before-quit", (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    clearTimeout(timer)
    const deadline = setTimeout(() => {
      log("credential-vault quit flush deadline reached; previous encrypted commit retained")
      app.quit()
    }, 2000)
    void ready
      .then(persist)
      .catch(() => {})
      .finally(() => {
        clearTimeout(deadline)
        app.quit()
      })
  })
  return {
    ready: () =>
      ready.then(() => {
        if (error)
          throw new GptProOperationError(
            "credential_storage",
            "Secure credential persistence needs recovery. Restore system secure storage before sending or importing.",
          )
      }),
    status: () => ({ phase: error ? ("unavailable" as const) : ("encrypted" as const), ...(error ? { error } : {}) }),
    async replace(cookies: SessionCookie[]) {
      await ready
      mutating = true
      clearTimeout(timer)
      try {
        await importSessionCookies(profile.cookies, cookies, log, persist)
      } finally {
        mutating = false
      }
    },
  }
}
