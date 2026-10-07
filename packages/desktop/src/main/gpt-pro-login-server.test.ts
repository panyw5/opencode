import { describe, expect, test } from "bun:test"
import { request } from "node:http"
import { GptProLoginServer } from "./gpt-pro-login-server"
import { renderLoginPage, resolveLoginLocale } from "./gpt-pro-login-page"

const extensionOrigin = `chrome-extension://${"a".repeat(32)}`
const cookie = {
  name: "__Secure-next-auth.session-token",
  value: "SYNTHETIC_PRIVATE_VALUE",
  domain: ".chatgpt.com",
  path: "/",
  secure: true,
  httpOnly: true,
  hostOnly: false,
  sameSite: "lax",
  session: true,
}

function http(url: string, input: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request(url, { method: input.method ?? "GET", headers: input.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }),
      )
    })
    req.on("error", reject)
    req.end(input.body)
  })
}

async function fixture(
  input: { ttl?: number; importCookies?: () => Promise<void>; imported?: () => Promise<void> } = {},
) {
  const logs: string[] = []
  let imports = 0
  const server = new GptProLoginServer({
    extensionDirectory: "/tmp/test-extension",
    ttl: input.ttl,
    importCookies: async () => {
      imports++
      await input.importCookies?.()
    },
    imported: input.imported ?? (async () => {}),
    log: (line) => logs.push(line),
  })
  const url = new URL(await server.start())
  const token = new URLSearchParams(url.hash.slice(1)).get("token")!
  const post = (cookies: unknown[] = [cookie], overrides: Record<string, string> = {}) =>
    http(`${url.origin}/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: extensionOrigin,
        Authorization: `Bearer ${token}`,
        ...overrides,
      },
      body: JSON.stringify({ version: 1, cookies }),
    })
  return { server, url, token, post, logs, imports: () => imports }
}

describe("one-time loopback ChatGPT login connection", () => {
  test("serves an isolated instruction page without reflecting its token", async () => {
    const f = await fixture()
    try {
      const page = await http(f.url.origin, { headers: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } })
      expect(page.status).toBe(200)
      expect(page.body).toContain("chrome://extensions")
      expect(page.body).toContain('lang="zh-CN"')
      expect(page.body).toContain("<title>OpenCode-ChatGPT 连接页</title>")
      expect(page.body).toContain("<h1>OpenCode-ChatGPT 连接页</h1>")
      expect(page.body).not.toContain("连接你的 ChatGPT 登录")
      expect(page.body).toContain("开发者模式")
      expect(page.body).toContain("回到当前 OpenCode-ChatGPT 连接页")
      expect(page.body.match(/<li>/g)).toHaveLength(5)
      expect(page.body).toContain("确保启用插件")
      expect(page.body).toContain("完成会话连接")
      expect(page.body).toContain("同意授权")
      expect(page.body).toContain("导入 ChatGPT 会话")
      expect(page.body).toContain("/tmp/test-extension")
      expect(page.body).not.toContain(f.token)
      expect(page.headers["referrer-policy"]).toBe("no-referrer")
      expect(page.headers["content-language"]).toBe("zh-CN")
      expect(page.headers.vary).toBe("Accept-Language")
      expect(JSON.stringify(f.server.status())).not.toContain(f.token)
    } finally {
      f.server.cancel()
    }
  })
  test("negotiates regional and script variants, priorities and English fallback", () => {
    for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-CN"])
      expect(resolveLoginLocale(tag)).toBe("zh_TW")
    for (const tag of ["zh", "zh-CN", "zh-SG", "zh-Hans-TW"]) expect(resolveLoginLocale(tag)).toBe("zh_CN")
    expect(resolveLoginLocale("fr-CA")).toBe("fr")
    expect(resolveLoginLocale("de-CH;q=0.2,ko;q=0.9")).toBe("ko")
    expect(resolveLoginLocale("zh-CN;q=0,ja;q=0.5")).toBe("ja")
    expect(resolveLoginLocale("zh;q=invalid,es;q=0.8")).toBe("es")
    expect(resolveLoginLocale("xx-ZZ,fr;q=0.5")).toBe("fr")
    expect(resolveLoginLocale("*")).toBe("en")
    expect(resolveLoginLocale("xx-ZZ")).toBe("en")
    expect(resolveLoginLocale()).toBe("en")
  })
  test("serves five localized steps in all eight languages without changing the connection URL", async () => {
    const f = await fixture()
    try {
      for (const language of ["en", "zh-CN", "zh-TW", "ja", "ko", "de", "fr", "es"]) {
        const page = await http(f.url.origin, { headers: { "Accept-Language": language } })
        const expected = renderLoginPage(language, "/tmp/test-extension")
        expect(page.status).toBe(200)
        expect(page.headers["content-language"]).toBe(language)
        expect(page.body).toBe(expected.html)
        expect(page.body.match(/<li>/g)).toHaveLength(5)
        expect(page.body).not.toMatch(/\{\w+\}/)
        expect(page.body).not.toContain(f.token)
        expect(page.headers["content-security-policy"]).toContain("default-src 'none'")
        expect(page.body).toContain('href="https://chatgpt.com/"')
      }
      const fallback = await http(f.url.origin)
      expect(fallback.headers["content-language"]).toBe("en")
      expect(fallback.body).toContain("OpenCode-ChatGPT connection page")
      expect(f.imports()).toBe(0)
      expect(f.server.status().phase).toBe("waiting")
    } finally {
      f.server.cancel()
    }
  })
  test("escapes the extension directory rather than interpreting it as HTML", () => {
    const page = renderLoginPage("zh-CN,<script>", '/tmp/<script>alert("x")</script>&connector')
    expect(page.html).not.toContain("<script>")
    expect(page.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;connector")
    expect(page.language).toBe("zh-CN")
  })
  test("rejects unauthorized and cross-origin imports before touching cookies", async () => {
    const f = await fixture()
    try {
      expect((await f.post([cookie], { Authorization: "Bearer wrong" })).status).toBe(403)
      expect((await f.post([cookie], { Origin: "https://evil.test" })).status).toBe(403)
      expect((await f.post([cookie], { Host: "evil.test" })).status).toBe(403)
      expect(f.imports()).toBe(0)
      expect(f.server.status().phase).toBe("waiting")
    } finally {
      f.server.cancel()
    }
  })
  test("rejects Google cookie scope even with valid connection authorization", async () => {
    const f = await fixture()
    const result = await f.post([{ ...cookie, domain: ".google.com" }])
    expect(result.status).toBe(400)
    expect(f.imports()).toBe(0)
    expect(f.server.status().phase).toBe("failed")
    expect(f.logs.join("\n")).not.toContain(cookie.value)
  })
  test("imports once and reports only non-secret metadata", async () => {
    const f = await fixture()
    const result = await f.post()
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body).phase).toBe("imported")
    expect(JSON.parse(result.body).importedCookies).toBe(1)
    expect(f.imports()).toBe(1)
    expect(result.body).not.toContain(cookie.value)
    expect(f.logs.join("\n")).not.toContain(cookie.value)
    expect(f.logs.join("\n")).not.toContain(f.token)
  })
  test("refuses duplicate imports while the first one is in progress", async () => {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = await fixture({
      importCookies: async () => {
        entered()
        await blocked
      },
    })
    const first = f.post()
    await started
    expect(f.server.cancel().phase).toBe("importing")
    expect((await f.post()).status).toBe(409)
    release()
    expect((await first).status).toBe(200)
    expect(f.imports()).toBe(1)
  })
  test("keeps successful import distinct from failure to reopen the browser", async () => {
    const f = await fixture({
      imported: async () => {
        throw new Error("PRIVATE_BROWSER_ERROR")
      },
    })
    expect((await f.post()).status).toBe(200)
    expect(f.server.status().phase).toBe("imported")
    expect(f.server.status().error).toContain("page could not be opened")
    expect(f.logs.join("\n")).not.toContain("PRIVATE_BROWSER_ERROR")
  })
  test("expires idle connections", async () => {
    const f = await fixture({ ttl: 20 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(f.server.status().phase).toBe("expired")
    expect(f.imports()).toBe(0)
  })
  test("cancels startup without leaving a connection listening", async () => {
    const server = new GptProLoginServer({
      extensionDirectory: "/tmp/test",
      importCookies: async () => {},
      imported: async () => {},
      log: () => {},
    })
    const started = server.start()
    server.cancel()
    await expect(started).rejects.toThrow("cancelled during startup")
    expect(server.status().phase).toBe("cancelled")
  })
  test("reuses an active login connection rather than spawning another", async () => {
    const f = await fixture()
    try {
      expect(await f.server.start()).toBe(f.url.href)
    } finally {
      f.server.cancel()
    }
  })
})
