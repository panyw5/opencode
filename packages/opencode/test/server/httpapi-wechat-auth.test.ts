import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { Server } from "../../src/server/server"
import { tmpdir, disposeAllInstances } from "../fixture/fixture"
import { WechatStorage } from "../../src/channel/wechat-storage"

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`HTTP WeChat lifecycle timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("real HTTP QR routes enforce authentication, fence stale attempts and never expose credentials", async () => {
  if (process.env.OPENCODE_WECHAT_HTTP_AUTH_CHILD !== "1") {
    // Full production HTTP/runtime tests use a sidecar-like process boundary;
    // unit-test mock layers otherwise share Effect's global memo map.
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, OPENCODE_WECHAT_HTTP_AUTH_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const code = await child.exited
    if (code !== 0) console.error(`${stdout}\n${stderr}`)
    expect(code).toBe(0)
    expect(stdout).toContain("[wechat-auth-http] authenticated full QR lifecycle verified")
    expect(stderr).toContain("0 fail")
    return
  }
  await using tmp = await tmpdir({ git: true })
  await Log.init({ print: false, level: "INFO" })
  const name = `wechat-http-${crypto.randomUUID()}`
  const secret = "PRIVATE_HTTP_BOT_TOKEN"
  const providerCalls: string[] = []
  const runtimeCalls: Array<{ endpoint: string; authorization: string | null }> = []
  const bindings = new Map<string, { token: string; botId: string; scannerUserId: string }>()
  let providerToken = secret
  let qr = 0
  let pollStatus = "need_verifycode"
  const originalFetch = globalThis.fetch
  const password = Flag.OPENCODE_SERVER_PASSWORD
  const username = Flag.OPENCODE_SERVER_USERNAME
  const envPassword = process.env.OPENCODE_SERVER_PASSWORD
  const envUsername = process.env.OPENCODE_SERVER_USERNAME
  Flag.OPENCODE_SERVER_PASSWORD = "test-http-password"
  Flag.OPENCODE_SERVER_USERNAME = "test-http-user"
  process.env.OPENCODE_SERVER_PASSWORD = "test-http-password"
  process.env.OPENCODE_SERVER_USERNAME = "test-http-user"
  globalThis.fetch = (async (input, init) => {
    const value = input instanceof Request ? input.url : String(input)
    const url = new URL(value)
    if (url.origin !== "https://ilinkai.weixin.qq.com") return originalFetch(input, init)
    providerCalls.push(`${url.pathname}${url.search}`)
    if (!url.pathname.endsWith("get_bot_qrcode") && !url.pathname.endsWith("get_qrcode_status")) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      runtimeCalls.push({ endpoint: url.pathname, authorization: headers.get("Authorization") })
    }
    if (url.pathname.endsWith("get_bot_qrcode"))
      return Response.json({ qrcode: `test-qr-${++qr}`, qrcode_img_content: "https://weixin.qq.com/test-qr-content" })
    if (url.pathname.endsWith("get_qrcode_status")) {
      if (pollStatus === "rejected") return Response.json({ ret: -14, errmsg: secret })
      const binding = bindings.get(url.searchParams.get("qrcode") ?? "") ?? {
        token: providerToken,
        botId: "test-http-bot",
        scannerUserId: "test-scanner",
      }
      return Response.json(
        pollStatus === "confirmed"
          ? {
              status: "confirmed",
              bot_token: binding.token,
              ilink_bot_id: binding.botId,
              ilink_user_id: binding.scannerUserId,
              baseurl: "https://ilinkai.weixin.qq.com",
            }
          : { status: pollStatus },
      )
    }
    return Response.json({ ret: 0, msgs: [] })
  }) as typeof fetch
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const request = async (url: string, payload?: object, authenticated = true, method = "POST") => {
    const response = await originalFetch(new URL(url, listener.url), {
      method: payload ? method : "GET",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
        ...(authenticated ? { authorization: `Basic ${btoa("test-http-user:test-http-password")}` } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    })
    const text = await response.text()
    expect(text).not.toContain(secret)
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }
  let previousChannels: Record<string, unknown> = {}
  try {
    previousChannels = (await request("/global/config")).body.channels ?? {}
    expect((await request("/im/wechat/login/start", { channelName: name }, false)).status).toBe(401)
    expect(providerCalls).toHaveLength(0)
    for (const channelName of ["../unsafe", "", "a".repeat(129), "space name"])
      expect((await request("/im/wechat/login/start", { channelName })).status).toBe(400)
    expect((await request("/im/wechat/login/start", {})).status).toBe(400)
    expect(providerCalls).toHaveLength(0)
    // Keep the test binding disabled so authorization tests cannot run any
    // unattended monitor against a real account after committing configuration.
    expect(
      (
        await request(
          "/global/config",
          { channels: { ...previousChannels, [name]: { type: "wechat", enabled: false } } },
          true,
          "PATCH",
        )
      ).status,
    ).toBe(200)
    const start = await request("/im/wechat/login/start", { channelName: name })
    expect(start.status).toBe(200)
    expect(start.body).toMatchObject({ status: "wait", qrContent: "https://weixin.qq.com/test-qr-content" })
    const attemptID = start.body.attemptID
    const count = providerCalls.length
    expect((await request("/im/wechat/login/poll", { channelName: name, attemptID: "stale" })).status).toBe(400)
    expect(providerCalls).toHaveLength(count)
    expect(
      (await request("/im/wechat/login/poll", { channelName: name, attemptID, verifyCode: { value: "123" } })).status,
    ).toBe(400)
    expect((await request("/im/wechat/login/poll", { channelName: name, attemptID })).body.status).toBe(
      "need_verifycode",
    )
    pollStatus = "confirmed"
    const confirmed = await request("/im/wechat/login/poll", { channelName: name, attemptID, verifyCode: "123456" })
    expect(confirmed.status).toBe(200)
    expect(confirmed.body).toMatchObject({
      status: "confirmed",
      account: { botId: "test-http-bot", scannerUserId: "test-scanner", baseUrl: "https://ilinkai.weixin.qq.com" },
    })
    expect(providerCalls.some((url) => url.includes("verify_code=123456"))).toBe(true)
    expect((await new WechatStorage().loadCredentials(name))?.token).toBe(secret)
    const publicConfig = (await request("/global/config")).body
    expect(publicConfig.channels[name]).toMatchObject({
      type: "wechat",
      enabled: false,
      botId: "test-http-bot",
      scannerUserId: "test-scanner",
    })
    expect((await request(`/im/wechat/status?channelName=${name}`)).body).toMatchObject({
      status: "stopped",
      botId: "test-http-bot",
    })
    const replacement = (await request("/im/wechat/login/start", { channelName: name })).body
    expect(replacement.attemptID).not.toBe(attemptID)
    expect((await request("/im/wechat/login/poll", { channelName: name, attemptID })).status).toBe(400)
    expect(
      (await request("/im/wechat/login/cancel", { channelName: name, attemptID: replacement.attemptID })).body.status,
    ).toBe("cancelled")
    const afterCancel = providerCalls.length
    expect(
      (await request("/im/wechat/login/poll", { channelName: name, attemptID: replacement.attemptID })).body.status,
    ).toBe("cancelled")
    expect(providerCalls).toHaveLength(afterCancel)
    const final = (await request("/im/wechat/login/start", { channelName: name })).body
    pollStatus = "rejected"
    expect((await request("/im/wechat/login/poll", { channelName: name, attemptID: final.attemptID })).status).toBe(400)
    // Exercise the real HTTP-triggered manager refresh, not a manual channel
    // stop/start: only the secret token changes on the second authorization.
    pollStatus = "confirmed"
    const beforeEnabled = (await request("/global/config")).body.channels
    expect(
      (
        await request(
          "/global/config",
          { channels: { ...beforeEnabled, [name]: { ...beforeEnabled[name], enabled: true, directory: tmp.path } } },
          true,
          "PATCH",
        )
      ).status,
    ).toBe(200)
    await until(
      () =>
        runtimeCalls.some((call) => call.endpoint.endsWith("getupdates") && call.authorization === `Bearer ${secret}`),
      "enabled original token polled",
    )
    const publicBeforeRefresh = (await request("/global/config")).body.channels[name]
    const refresh = (await request("/im/wechat/login/start", { channelName: name })).body
    providerToken = `${secret}_REFRESHED`
    const beforeLifecycle = runtimeCalls.length
    expect(
      (await request("/im/wechat/login/poll", { channelName: name, attemptID: refresh.attemptID })).body.status,
    ).toBe("confirmed")
    await until(
      () =>
        runtimeCalls.some(
          (call) => call.endpoint.endsWith("getupdates") && call.authorization === `Bearer ${providerToken}`,
        ),
      "HTTP unchanged public binding restarted with new token",
    )
    const refreshCalls = runtimeCalls.slice(beforeLifecycle)
    const stopped = refreshCalls.findIndex(
      (call) => call.endpoint.endsWith("notifystop") && call.authorization === `Bearer ${secret}`,
    )
    const started = refreshCalls.findIndex(
      (call) => call.endpoint.endsWith("notifystart") && call.authorization === `Bearer ${providerToken}`,
    )
    expect(stopped).toBeGreaterThanOrEqual(0)
    expect(started).toBeGreaterThan(stopped)
    expect((await request("/global/config")).body.channels[name]).toEqual(publicBeforeRefresh)
    expect((await new WechatStorage().loadCredentials(name))?.token).toBe(providerToken)
    const starts = runtimeCalls.filter((call) => call.endpoint.endsWith("notifystart")).length
    const stops = runtimeCalls.filter((call) => call.endpoint.endsWith("notifystop")).length
    await request("/im/wechat/login/poll", { channelName: name, attemptID: refresh.attemptID })
    await request("/im/wechat/login/poll", { channelName: name, attemptID: refresh.attemptID })
    expect(runtimeCalls.filter((call) => call.endpoint.endsWith("notifystart"))).toHaveLength(starts)
    expect(runtimeCalls.filter((call) => call.endpoint.endsWith("notifystop"))).toHaveLength(stops)
    // Two independently authorized channels commit concurrently; the binding
    // lock must rebase against the latest map and retain both account records.
    const nameA = `${name}-a`
    const nameB = `${name}-b`
    const beforeConcurrent = (await request("/global/config")).body.channels
    await request(
      "/global/config",
      {
        channels: {
          ...beforeConcurrent,
          [nameA]: { type: "wechat", enabled: false },
          [nameB]: { type: "wechat", enabled: false },
        },
      },
      true,
      "PATCH",
    )
    const attemptA = (await request("/im/wechat/login/start", { channelName: nameA })).body
    bindings.set(`test-qr-${qr}`, { token: `${secret}_A`, botId: "test-bot-a", scannerUserId: "scanner-a" })
    const attemptB = (await request("/im/wechat/login/start", { channelName: nameB })).body
    bindings.set(`test-qr-${qr}`, { token: `${secret}_B`, botId: "test-bot-b", scannerUserId: "scanner-b" })
    const [resultA, resultB] = await Promise.all([
      request("/im/wechat/login/poll", { channelName: nameA, attemptID: attemptA.attemptID }),
      request("/im/wechat/login/poll", { channelName: nameB, attemptID: attemptB.attemptID }),
    ])
    expect(resultA.body.status).toBe("confirmed")
    expect(resultB.body.status).toBe("confirmed")
    const committed = (await request("/global/config")).body.channels
    expect(committed[nameA]).toMatchObject({ botId: "test-bot-a", scannerUserId: "scanner-a", enabled: false })
    expect(committed[nameB]).toMatchObject({ botId: "test-bot-b", scannerUserId: "scanner-b", enabled: false })
    expect(committed[name]).toEqual(publicBeforeRefresh)
    const logs = await fs.readFile(Log.file(), "utf8")
    expect(logs).toContain("WeChat account binding committed")
    expect(logs).not.toContain(secret)
    console.info("[wechat-auth-http] authenticated full QR lifecycle verified")
  } finally {
    await request("/global/config", { channels: previousChannels }, true, "PATCH")
    await listener.stop(true)
    await disposeAllInstances()
    globalThis.fetch = originalFetch
    Flag.OPENCODE_SERVER_PASSWORD = password
    Flag.OPENCODE_SERVER_USERNAME = username
    if (envPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = envPassword
    if (envUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
    else process.env.OPENCODE_SERVER_USERNAME = envUsername
  }
}, 60_000)
