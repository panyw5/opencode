import { describe, expect, test } from "bun:test"
import {
  buildFixtureConfig,
  parseArgs,
  redact,
  sidecarEnv,
  smokeStartCommand,
  PERMISSION_MARKER,
  REPLY_MARKER,
} from "./packaged-size-smoke"

test("parseArgs accepts exactly the Resources and artifacts directories", () => {
  expect(parseArgs(["/a/Resources", "/tmp/smoke"])).toEqual({ resources: "/a/Resources", artifacts: "/tmp/smoke" })
})

test("parseArgs rejects missing or extra positional arguments", () => {
  expect(() => parseArgs([])).toThrow("two arguments")
  expect(() => parseArgs(["/a/Resources"])).toThrow("two arguments")
  expect(() => parseArgs(["/a/Resources", "/tmp/smoke", "/extra"])).toThrow("two arguments")
})

test("parseArgs ignores flags while keeping positional order", () => {
  expect(parseArgs(["--node-sidecar", "/a/Resources", "/tmp/smoke"])).toEqual({
    resources: "/a/Resources",
    artifacts: "/tmp/smoke",
  })
})

test("fixture config keeps last-match-wins permission order and isolated provider", () => {
  const config = buildFixtureConfig("http://127.0.0.1:9") as {
    permission: Record<string, string>
    provider: Record<string, { options: { baseURL: string; apiKey: string }; models: Record<string, unknown> }>
    model: string
  }
  expect(Object.keys(config.permission)).toEqual(["*", "bash"])
  expect(config.permission).toEqual({ "*": "deny", bash: "ask" })
  expect(config.model).toBe("remote-qa/echo")
  const provider = config.provider["remote-qa"]
  expect(provider.options.baseURL).toBe("http://127.0.0.1:9/v1")
  expect(provider.options.apiKey).toBe("isolated-smoke-key")
  expect(Object.keys(provider.models)).toEqual(["echo"])
})

test("sidecar environment isolates home, database and network to the smoke root", () => {
  const env = sidecarEnv("/tmp/smoke/node-sidecar", buildFixtureConfig("http://127.0.0.1:9/v1"), "secret", {})
  expect(env.HOME).toBe("/tmp/smoke/node-sidecar")
  expect(env.XDG_DATA_HOME).toBe("/tmp/smoke/node-sidecar/data")
  expect(env.XDG_CONFIG_HOME).toBe("/tmp/smoke/node-sidecar/config")
  expect(env.OPENCODE_DB).toBe("/tmp/smoke/node-sidecar/sidecar.db")
  expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1")
  expect(env.OPENCODE_SERVER_USERNAME).toBe("opencode")
  expect(env.OPENCODE_SERVER_PASSWORD).toBe("secret")
  expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true")
  expect(env.OPENCODE_PURE).toBe("true")
  const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { permission: Record<string, string> }
  expect(parsed.permission.bash).toBe("ask")
})

test("sidecar environment never inherits host provider credentials or config overrides", () => {
  const env = sidecarEnv("/tmp/smoke/node-sidecar", buildFixtureConfig("http://127.0.0.1:9/v1"), "secret", {
    PATH: "/usr/bin",
    LANG: "en_US.UTF-8",
    OPENAI_API_KEY: "host-openai",
    ANTHROPIC_API_KEY: "host-anthropic",
    AWS_SECRET_ACCESS_KEY: "host-aws",
    GITHUB_TOKEN: "host-github",
    DATABASE_PASSWORD: "host-db",
    MY_SERVICE_CREDENTIALS: "host-creds",
    OPENCODE_CONFIG: "/host/override.json",
    OPENCODE_CONFIG_CONTENT: '{"host": true}',
    OPENCODE_SERVER_PASSWORD: "stale-host-password",
    OPENCODE_SERVER_USERNAME: "stale",
  })
  expect(env.PATH).toBe("/usr/bin")
  expect(env.LANG).toBe("en_US.UTF-8")
  expect(env.OPENAI_API_KEY).toBeUndefined()
  expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  expect(env.GITHUB_TOKEN).toBeUndefined()
  expect(env.DATABASE_PASSWORD).toBeUndefined()
  expect(env.MY_SERVICE_CREDENTIALS).toBeUndefined()
  expect(env.OPENCODE_CONFIG).toBeUndefined()
  expect(env.OPENCODE_SERVER_PASSWORD).toBe("secret")
  expect(env.OPENCODE_SERVER_USERNAME).toBe("opencode")
  const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { host?: boolean }
  expect(parsed.host).toBeUndefined()
})

test("redact removes the temporary password from captured logs", () => {
  const log = "sidecar lifecycle listen-ready password=secret done"
  expect(redact(log, "secret")).not.toContain("secret")
  expect(redact(log, "secret")).toContain("[redacted]")
  expect(redact("plain", "")).toBe("plain")
})

test("start command keeps the port numeric so the packaged sidecar accepts it", () => {
  expect(smokeStartCommand("127.0.0.1", 4321, "secret")).toEqual({
    type: "start",
    hostname: "127.0.0.1",
    port: 4321,
    password: "secret",
    needsMigration: true,
  })
  expect(Number.isInteger(smokeStartCommand("127.0.0.1", 4321, "secret").port)).toBe(true)
})

test("smoke markers stay distinct so reply and tool output are checked separately", () => {
  expect(REPLY_MARKER).not.toBe(PERMISSION_MARKER)
  expect(REPLY_MARKER).toMatch(/^[A-Z_]+$/)
  expect(PERMISSION_MARKER).toMatch(/^[A-Z_]+$/)
})
