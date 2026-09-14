import { afterEach, describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import { createServer } from "node:http"
import path from "node:path"
import WebSocket, { WebSocketServer } from "ws"
import { Flag } from "@opencode-ai/core/flag/flag"
import { startQQChannel } from "../../src/channel/qq"
import { IMMessageTable } from "../../src/im/inbox.sql"
import { IMOwnerTable } from "../../src/im/owner.sql"
import { Database, eq } from "../../src/storage/db"

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"

let previousDB: string | undefined
let dbPath: string | undefined

afterEach(() => {
  Database.close()
  if (previousDB === undefined) delete Flag.OPENCODE_DB
  else Flag.OPENCODE_DB = previousDB
  if (dbPath) rmSync(path.dirname(dbPath), { recursive: true, force: true })
  previousDB = undefined
  dbPath = undefined
})

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("mock HTTP server did not bind")
  return address.port
}

async function waitForMessage(channelName: string, eventID: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const row = Database.use((db) =>
      db
        .select()
        .from(IMMessageTable)
        .where(eq(IMMessageTable.channel_name, channelName))
        .all()
        .find((item) => item.event_id === eventID),
    )
    if (row) return row
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for QQ message ${eventID}`)
}

async function waitForOwner(channelName: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const row = Database.use((db) => db.select().from(IMOwnerTable).where(eq(IMOwnerTable.channel_name, channelName)).get())
    if (row) return row
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for QQ owner ${channelName}`)
}

describe("QQ gateway inbound path", () => {
  test("discovers the fixed owner from an allowed C2C event without project grants or global channel config", async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "qq-gateway-"))
    dbPath = path.join(temp, "opencode.db")
    previousDB = Flag.OPENCODE_DB
    Flag.OPENCODE_DB = dbPath
    Database.Client.reset()
    Database.Client({ disableChannelDb: true, skipMigrations: false })

    const posted: string[] = []
    const http = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/gateway") {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ url: `ws://127.0.0.1:${wsPort}` }))
        return
      }
      posted.push(request.url ?? "")
      response.statusCode = 200
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ code: 0, id: "mock-outbound" }))
    })
    const httpPort = await listen(http)
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.once("listening", resolve))
    const wsAddress = wss.address()
    if (!wsAddress || typeof wsAddress === "string") throw new Error("mock WS server did not bind")
    const wsPort = wsAddress.port
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as { op?: number }
        if (frame.op !== 2) return
        const event = {
          op: 0,
          t: "C2C_MESSAGE_CREATE",
          s: 1,
          d: {
            id: "qq-event-1",
            content: "hello <@123>",
            timestamp: new Date().toISOString(),
            author: { user_openid: "allowed-user" },
          },
        }
        socket.send(JSON.stringify(event))
        socket.send(JSON.stringify(event))
        socket.send(JSON.stringify({ ...event, s: 2, d: { ...event.d, id: "foreign-event", author: { user_openid: "foreign-user" } } }))
      })
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      if (String(input) === TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch(input, init)
    }
    const handle = startQQChannel({
      name: "qq-gateway-test",
      config: {
        type: "qq",
        appId: "mock-app",
        clientSecret: "mock-secret",
        apiBaseUrl: `http://127.0.0.1:${httpPort}`,
        allowedUsers: ["allowed-user"],
        autoReply: false,
      },
      baseUrl: "http://127.0.0.1:1",
      directory: temp,
    })
    try {
      const row = await waitForMessage("qq-gateway-test", "qq-event-1")
      expect(row.text).toBe("hello")
      expect(row.scope).toBe("c2c")
      expect(row.conversation_id).toBe("private:allowed-user")
      expect(row.sender_id).toBe("allowed-user")
      const owner = await waitForOwner("qq-gateway-test")
      expect(owner).toMatchObject({ platform: "qq", conversation_id: "private:allowed-user", sender_id: "allowed-user" })
      expect(Database.use((db) => db.select().from(IMMessageTable).where(eq(IMMessageTable.channel_name, "qq-gateway-test")).all())).toHaveLength(1)
      expect(posted).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
      handle.stop()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  })
})
