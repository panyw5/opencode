import { Database } from "bun:sqlite"
import { join } from "node:path"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import type { Cookie } from "electron"
import { GptProCredentialVault } from "../src/main/gpt-pro-credential-vault"
import { createGptProExecutionStore } from "../src/main/gpt-pro-execution-store"
import { createGptProBodyJournal } from "../src/main/gpt-pro-body-journal"
import type { GptProJob } from "@opencode-ai/util/gpt-pro"

// Deterministic key is exclusively for synthetic crash fixtures, never an application credential path.
export function syntheticVault(root: string) {
  const key = Buffer.alloc(32, 7)
  return new GptProCredentialVault({
    path: join(root, "synthetic.enc"),
    available: () => true,
    encrypt: (value) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      const data = Buffer.concat([cipher.update(value), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), data])
    },
    decrypt: (value) => {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString()
    },
    log: () => {},
  })
}
export const crashJob = (): GptProJob => ({
  id: "gpt_synthetic_crash",
  owner: "synthetic",
  requestID: "crash",
  prompt: "Synthetic managed question",
  phase: "paused",
  url: "https://chatgpt.com/",
  accountID: "original-account-hash",
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  submitted: false,
  text: "previous durable body",
})
export async function crashFixture(mode: string, root: string) {
  const bodies = createGptProBodyJournal(join(root, "bodies"), () => {}, { checkpointMs: 60_000 })
  const execution = createGptProExecutionStore(new Database(join(root, "execution.db")), () => {}, 60_000, bodies)
  const job = crashJob()
  execution.load(() => [job])
  if (mode === "intent") {
    execution.save([{ ...job, phase: "sending", sendAttempted: true }])
    process.exit(71) // Crash after durable intent, before any trusted input.
  }
  if (mode === "vault") {
    const cookie = {
      name: "__Secure-next-auth.session-token",
      value: "SYNTHETIC_VERIFIED_SAME_ACCOUNT",
      domain: ".chatgpt.com",
      path: "/",
      secure: true,
      httpOnly: true,
      hostOnly: false,
      sameSite: "lax",
      session: true,
    } as Cookie
    await syntheticVault(root).write([cookie])
    process.exit(72) // Crash between candidate vault commit and execution/profile promotion.
  }
  if (mode === "body") {
    execution.save([
      {
        ...job,
        phase: "generating",
        submitted: true,
        sendAttempted: true,
        userID: "original-user-turn",
        text: "new checkpointed body",
        revision: 2,
      },
    ])
    await execution.flush()
    process.exit(73) // Body is durable but completion metadata/notification was never committed.
  }
  throw Error("Unknown synthetic crash stage")
}
if (import.meta.main) await crashFixture(process.argv[2], process.argv[3])
