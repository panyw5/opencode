import { expect, test } from "bun:test"
import { createServer } from "node:http"
import path from "node:path"
import fs from "node:fs/promises"
import { Server } from "../../src/server/server"
import { startWechatChannel } from "../../src/channel/wechat"
import { WechatApi, type Message } from "../../src/channel/wechat-api"
import { WechatStorage } from "../../src/channel/wechat-storage"
import { registry } from "../../src/im/transport"
import { IMMessageTable } from "../../src/im/inbox.sql"
import { IMAttachmentTable } from "../../src/im/inbox.sql"
import { Database, eq } from "../../src/storage/db"
import { messageRecordID } from "../../src/im/model"
import { tmpdir, disposeAllInstances } from "../fixture/fixture"
import { reply, type Item } from "../lib/llm-server"
import * as Log from "@opencode-ai/core/util/log"
import { createCipheriv } from "node:crypto"

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`WeChat end-to-end readiness timeout: ${label}`)
}

test("provider inbound reaches HTTP inbox, subscription model and explicit im_send without duplicate delivery", async () => {
  if (process.env.OPENCODE_WECHAT_E2E_CHILD !== "1") {
    // Effect's process-wide memo map is shared with unit-test layers providing
    // mock owners. A real sidecar owns its runtime in a separate process too.
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, OPENCODE_WECHAT_E2E_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, errors] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const code = await child.exited
    const logs = `${output}\n${errors}`
    if (code !== 0) console.error(logs)
    expect(code).toBe(0)
    expect(logs).toContain("[wechat-e2e] full provider/subscription/model/send/autoReply verified")
    expect(logs).toContain("1 pass")
    expect(logs).toContain("0 fail")
    return
  }
  await using tmp = await tmpdir({ git: true })
  await Log.init({ print: false, level: "INFO" })
  const incoming: Message[] = []
  const received: Message[] = []
  const llmReplies: Item[] = []
  const modelRequests: Record<string, unknown>[] = []
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  )
  const pngBase64 = png.toString("base64")
  const mediaKey = Buffer.from("00112233445566778899aabbccddeeff", "hex")
  const cipher = createCipheriv("aes-128-ecb", mediaKey, null)
  const encryptedPng = Buffer.concat([cipher.update(png), cipher.final()])
  const cdn = new Map<string, Buffer>([
    ["/subscription.png", encryptedPng],
    ["/auto.png", encryptedPng],
    ["/active.svg", Buffer.from("<svg><script>alert(1)</script></svg>")],
  ])
  let mediaDownloads = 0
  let cursor = 0
  // Two real HTTP hops: WeChat's injected fetch rewrites only in this test;
  // the production API still validates and addresses its HTTPS allowlisted host.
  const upstream = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    response.setHeader("content-type", "application/json")
    if (request.url?.endsWith("/getupdates")) {
      const msgs = incoming.splice(0)
      response.end(JSON.stringify({ ret: 0, msgs, get_updates_buf: String(++cursor) }))
    } else if (request.url?.endsWith("/sendmessage")) {
      received.push(body.msg)
      response.end('{"ret":0}')
    } else if (request.url?.endsWith("/chat/completions")) {
      modelRequests.push(body)
      const item = llmReplies.shift()
      if (!item || item.type !== "sse") {
        response.statusCode = 500
        response.end("unexpected model request")
        return
      }
      response.setHeader("content-type", "text/event-stream")
      response.end(
        [...item.head, ...item.tail].map((line) => `data: ${JSON.stringify(line)}\n\n`).join("") + "data: [DONE]\n\n",
      )
    } else response.end('{"ret":0}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  if (!address || typeof address === "string") throw new Error("Mock provider failed to listen")
  const providerUrl = `http://127.0.0.1:${address.port}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const value = input instanceof Request ? input.url : String(input)
    const url = new URL(value)
    if (url.hostname === "novac2c.cdn.weixin.qq.com") {
      mediaDownloads++
      const data = cdn.get(url.pathname)
      return data ? new Response(data) : new Response(null, { status: 404 })
    }
    return originalFetch(input, init)
  }) as typeof fetch
  const name = `wechat-e2e-${crypto.randomUUID()}`
  const baseUrl = "https://ilinkai.weixin.qq.com"
  const config = {
    type: "wechat" as const,
    botId: name,
    scannerUserId: "owner",
    baseUrl,
    autoReply: false,
    model: "test/test-model",
  }
  await fs.writeFile(
    path.join(tmp.path, "opencode.json"),
    JSON.stringify({
      model: "test/test-model",
      permission: { im_send: "allow" },
      provider: {
        test: {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              name: "Test Model",
              tool_call: true,
              attachment: true,
              modalities: { input: ["text", "image"], output: ["text"] },
              limit: { context: 100000, output: 10000 },
              cost: { input: 0, output: 0 },
            },
          },
          options: { apiKey: "test", baseURL: `${providerUrl}/v1` },
        },
      },
    }),
  )
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const request = async (url: string, body?: object, method = "POST") => {
    const result = await fetch(new URL(url, listener.url), {
      method: body ? method : "GET",
      headers: { "content-type": "application/json", "x-opencode-directory": tmp.path },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await result.json()
    if (!result.ok) throw new Error(`Sidecar test ${url} failed ${result.status}: ${JSON.stringify(data)}`)
    return data
  }
  const storage = new WechatStorage(path.join(tmp.path, "wechat-private"))
  const previousChannels = (await request("/global/config")).channels ?? {}
  await storage.saveCredentials(name, { botId: name, scannerUserId: "owner", baseUrl, token: "test-private-token" })
  const api = new WechatApi({
    token: "test-private-token",
    fetch: ((url, init) => fetch(`${providerUrl}${new URL(String(url)).pathname}`, init)) as typeof fetch,
  })
  let handle: Awaited<ReturnType<typeof startWechatChannel>>
  try {
    await request("/global/config", { channels: { [name]: config } }, "PATCH")
    handle = await startWechatChannel({
      name,
      config,
      baseUrl: String(listener.url),
      directory: tmp.path,
      storage,
      api,
    })
    if (!handle) throw new Error("Test channel failed to start")
    registry.register(handle.transport)
    const raw = (id: string, text: string): Message => ({
      message_id: id,
      message_type: 1,
      from_user_id: "owner",
      context_token: `private-context-${id}`,
      create_time_ms: Date.now(),
      item_list: [{ type: 1, text_item: { text } }],
    })
    const mediaRaw = (id: string, item: NonNullable<Message["item_list"]>[number], text?: string): Message => ({
      message_id: id,
      message_type: 1,
      from_user_id: "owner",
      context_token: `private-context-${id}`,
      create_time_ms: Date.now(),
      item_list: [...(text ? [{ type: 1, text_item: { text } }] : []), item],
    })
    incoming.push(raw("seed", "discover fixed owner"))
    await waitFor(
      () =>
        Database.use((db) => db.select().from(IMMessageTable).where(eq(IMMessageTable.channel_name, name)).all()).find(
          (row) => row.event_id === "seed",
        ),
      "durable owner seed",
    )
    const page = await waitFor(async () => {
      try {
        const value = await request(`/im/messages?channelName=${encodeURIComponent(name)}`)
        return value.items?.length ? value : undefined
      } catch {
        return undefined
      }
    }, "HTTP readable inbox")
    expect(page.items[0].text).toBe("discover fixed owner")
    expect(JSON.stringify(page)).not.toContain("private-context")
    const channels = await request("/im/channels")
    expect(channels.find((item: { channelName: string }) => item.channelName === name)).toMatchObject({
      platform: "wechat",
      recipientStatus: "ready",
    })
    const session = await request("/session", { title: "WeChat subscription end to end" })
    const subscription = await request("/im/subscriptions", { channelName: name, sessionID: session.id })
    llmReplies.push(
      reply().tool("im_send", { channelName: name, text: "explicit subscription reply" }).item(),
      reply().text("subscription finished").stop().item(),
    )
    const message = raw("wake", "wake the subscribed session and send a reply")
    incoming.push(message, message)
    const sent = await waitFor(
      () => received.find((item) => item.item_list?.[0]?.text_item?.text === "explicit subscription reply"),
      "provider received model im_send",
    )
    expect(sent.to_user_id).toBe("owner")
    expect(sent.context_token).toBe("private-context-wake")
    await waitFor(() => (modelRequests.length >= 2 ? modelRequests : undefined), "model finished turn")
    const messages = await waitFor(async () => {
      const values = await request(`/session/${session.id}/message`)
      return values.some((item: { parts: Array<{ text?: string }> }) =>
        item.parts.some((part) => part.text === "subscription finished"),
      )
        ? values
        : undefined
    }, "persisted assistant result")
    expect(messages.filter((item: { info: { role: string } }) => item.info.role === "user")).toHaveLength(1)
    expect(received).toHaveLength(1)
    expect(modelRequests).toHaveLength(2)
    expect(
      Database.use((db) => db.select().from(IMMessageTable).where(eq(IMMessageTable.channel_name, name)).all()).filter(
        (row) => row.event_id === "wake",
      ),
    ).toHaveLength(1)
    llmReplies.push(reply().text("subscription image processed").stop().item())
    const subscribedImage = mediaRaw(
      "subscribed-image",
      {
        type: 2,
        image_item: {
          aeskey: mediaKey.toString("hex"),
          mid_size: encryptedPng.length,
          media: { full_url: "https://novac2c.cdn.weixin.qq.com/subscription.png" },
        },
      },
      "inspect the subscribed image",
    )
    incoming.push(subscribedImage, subscribedImage)
    await waitFor(() => (modelRequests.length === 3 ? true : undefined), "subscription media reached model")
    const subscribedModelBody = JSON.stringify(modelRequests[2])
    expect(subscribedModelBody).toContain("data:image/png;base64,")
    expect(
      Buffer.from(subscribedModelBody.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)?.[1] ?? "", "base64").length,
    ).toBeGreaterThan(8)
    expect(mediaDownloads).toBe(1)
    const attachment = await waitFor(
      () =>
        Database.use((db) => db.select().from(IMAttachmentTable).all()).find(
          (item) => item.message_id === messageRecordID("wechat", name, "subscribed-image") && item.status === "ready",
        ),
      "encrypted image stored as durable attachment BLOB",
    )
    expect(attachment.mime).toBe("image/png")
    expect(Buffer.from(attachment.data!)).toEqual(png)
    const sessionWithImage = await request(`/session/${session.id}/message`)
    expect(JSON.stringify(sessionWithImage)).toContain(`data:image/png;base64,${pngBase64}`)
    const mediaPage = await request(`/im/messages?channelName=${encodeURIComponent(name)}`)
    expect(JSON.stringify(mediaPage)).toContain('"mime":"image/png"')
    expect(JSON.stringify(mediaPage)).not.toContain(pngBase64)
    // Reconfigure the same account after releasing the old monitor; now no
    // subscription consumes the event and the legacy automatic reply path runs.
    await request(`/im/subscriptions/${subscription.id}/stop`, {})
    await waitFor(
      () =>
        Database.use((db) => db.select().from(IMMessageTable).where(eq(IMMessageTable.channel_name, name)).all()).find(
          (row) => row.event_id === "seed" && row.legacy_status === "completed",
        ),
      "disabled automatic reply seed sealed",
    )
    registry.unregister(name, handle.transport)
    await handle.stop()
    const autoConfig = { ...config, autoReply: true }
    await request("/global/config", { channels: { [name]: autoConfig } }, "PATCH")
    handle = await startWechatChannel({
      name,
      config: autoConfig,
      baseUrl: String(listener.url),
      directory: tmp.path,
      storage,
      api,
    })
    if (!handle) throw new Error("Reconfigured channel failed to start")
    registry.register(handle.transport)
    llmReplies.push(reply().text("automatic final answer").stop().item())
    const auto = raw("auto", "answer automatically without a subscription")
    incoming.push(auto, auto)
    const autoSend = await waitFor(
      () => received.find((item) => item.item_list?.[0]?.text_item?.text === "automatic final answer"),
      "provider received autoReply model final text",
    )
    expect(autoSend.context_token).toBe("private-context-auto")
    await waitFor(
      () =>
        Database.use((db) => db.select().from(IMMessageTable).where(eq(IMMessageTable.channel_name, name)).all()).find(
          (row) => row.event_id === "auto" && row.legacy_status === "completed",
        ),
      "automatic reply durable completion",
    )
    expect(received).toHaveLength(2)
    expect(modelRequests).toHaveLength(4)
    llmReplies.push(reply().text("automatic image answer").stop().item())
    const automaticImage = mediaRaw(
      "automatic-image",
      {
        type: 2,
        image_item: {
          aeskey: mediaKey.toString("hex"),
          mid_size: encryptedPng.length,
          media: { full_url: "https://novac2c.cdn.weixin.qq.com/auto.png" },
        },
      },
      "answer with this automatic image",
    )
    incoming.push(automaticImage, automaticImage)
    await waitFor(
      () => received.find((item) => item.item_list?.[0]?.text_item?.text === "automatic image answer"),
      "autoReply media model final text reached provider",
    )
    const automaticModelBody = JSON.stringify(modelRequests[4])
    expect(automaticModelBody).toContain("data:image/png;base64,")
    expect(
      Buffer.from(automaticModelBody.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)?.[1] ?? "", "base64").length,
    ).toBeGreaterThan(8)
    expect(mediaDownloads).toBe(2)
    expect(
      Database.use((db) => db.select().from(IMMessageTable).where(eq(IMMessageTable.channel_name, name)).all()).filter(
        (row) => row.event_id === "automatic-image",
      ),
    ).toHaveLength(1)
    const beforeRejectedModel = modelRequests.length
    const beforeUntrustedDownloads = mediaDownloads
    incoming.push(
      mediaRaw("rejected-svg", {
        type: 2,
        image_item: { media: { full_url: "https://novac2c.cdn.weixin.qq.com/active.svg" } },
      }),
      mediaRaw("untrusted-media", {
        type: 2,
        image_item: { media: { full_url: "https://evil.test/image.png" } },
      }),
    )
    const rejectedIDs = new Set([
      messageRecordID("wechat", name, "rejected-svg"),
      messageRecordID("wechat", name, "untrusted-media"),
    ])
    await waitFor(
      () =>
        Database.use((db) => db.select().from(IMAttachmentTable).all()).filter((item) =>
          rejectedIDs.has(item.message_id),
        ).length === 2
          ? true
          : undefined,
      "rejected media descriptors checkpointed",
    )
    const rejected = Database.use((db) => db.select().from(IMAttachmentTable).all()).filter((item) =>
      rejectedIDs.has(item.message_id),
    )
    expect(rejected.map((item) => item.status)).toEqual(["rejected", "rejected"])
    expect(rejected.every((item) => !item.data && item.size === 0)).toBe(true)
    expect(mediaDownloads).toBe(beforeUntrustedDownloads + 1)
    await waitFor(() => {
      const completed = Database.use((db) =>
        db.select().from(IMMessageTable).where(eq(IMMessageTable.channel_name, name)).all(),
      ).filter((row) => ["rejected-svg", "untrusted-media"].includes(row.event_id) && row.legacy_status === "completed")
      return completed.length === 2 ? true : undefined
    }, "rejected media messages checkpointed without model execution")
    expect(modelRequests).toHaveLength(beforeRejectedModel)
    const logs = await fs.readFile(Log.file(), "utf8")
    expect(logs).toContain("private message persisted")
    expect(logs).toContain("private send accepted")
    expect(logs).not.toContain("test-private-token")
    expect(logs).not.toContain("private-context-wake")
    console.info("[wechat-e2e] full provider/subscription/model/send/autoReply verified")
  } catch (error) {
    const logs = await fs.readFile(Log.file(), "utf8").catch(() => "test log unavailable")
    console.error("WeChat end-to-end failure diagnostics", {
      modelCalls: modelRequests.length,
      providerSends: received.length,
      rows: Database.use((db) =>
        db.select().from(IMMessageTable).where(eq(IMMessageTable.channel_name, name)).all(),
      ).map((row) => ({ eventID: row.event_id, status: row.legacy_status })),
      logs: logs
        .split("\n")
        .filter((line) => !line.includes("file.watcher.updated"))
        .slice(-80)
        .join("\n"),
    })
    throw error
  } finally {
    registry.unregister(name, handle?.transport)
    await handle?.stop()
    await request("/global/config", { channels: previousChannels }, "PATCH")
    await listener.stop(true)
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    globalThis.fetch = originalFetch
    await disposeAllInstances()
  }
}, 60_000)
