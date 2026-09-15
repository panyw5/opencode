import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { IM } from "../../src/im/service"
import { Target } from "../../src/im/model"
import { registry } from "../../src/im/transport"
import { WechatApi } from "../../src/channel/wechat-api"
import { createWechatTransport } from "../../src/channel/wechat"
import { Database } from "../../src/storage/db"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(IM.defaultLayer)
function createProject() {
  const id = ProjectID.ascending()
  const now = Date.now()
  Database.use((db) => db.insert(ProjectTable).values({ id, worktree: "/tmp", sandboxes: [], time_created: now, time_updated: now }).run())
  return id
}

it.live("WeChat timeout persists unknown without retry and client IDs are project/send scoped", () => Effect.gen(function* () {
  const im = yield* IM.Service
  const name = `wechat-send-${crypto.randomUUID()}`
  let mode: "timeout" | "success" = "timeout"
  const clientIDs: string[] = []
  const api = new WechatApi({ token: "private-account", timeoutMs: 5, fetch: (async (_url, init) => {
    clientIDs.push(JSON.parse(String(init?.body)).msg.client_id)
    if (mode === "success") return Response.json({ ret: 0 })
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal
      if (signal?.aborted) return reject(signal.reason)
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  }) as typeof fetch })
  const transport = createWechatTransport({ name, config: { type: "wechat", scannerUserId: "owner" }, accountKey: "test-account", api,
    storage: { loadContext: async () => ({ token: "private-context", messageId: "event", timestamp: Date.now() }) } })
  registry.register(transport)
  try {
    const projectID = createProject()
    const input = { id: "stable-send", projectID, platform: "wechat" as const, channelName: name, mode: "proactive" as const,
      target: new Target({ platform: "wechat", channelName: name, scope: "c2c", conversationID: "owner", senderID: "owner" }), text: "notification" }
    const first = yield* im.sendText(input)
    expect(first.status).toBe("unknown")
    expect(first.attemptCount).toBe(1)
    expect(first.lastError).not.toContain("private-account")
    expect(first.lastError).not.toContain("private-context")
    expect(clientIDs).toEqual([createHash("sha256").update(JSON.stringify([projectID, input.id])).digest("hex")])
    mode = "success"
    expect((yield* im.sendText(input)).status).toBe("unknown")
    expect(clientIDs).toHaveLength(1)
    expect((yield* im.sendText({ ...input, projectID: createProject() })).status).toBe("sent")
    expect(clientIDs).toHaveLength(2)
    expect(clientIDs[1]).not.toBe(clientIDs[0])
  } finally { registry.unregister(name, transport) }
}))
