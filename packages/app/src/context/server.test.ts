import { describe, expect, test } from "bun:test"
import { projectsKey, resolveProjectsListKey, resolveServerList, ServerConnection } from "./server"

describe("resolveServerList", () => {
  test("lets startup auth_token credentials override a persisted same-url server", () => {
    const list = resolveServerList({
      stored: [{ url: "https://server.example.test" }],
      props: [
        {
          type: "http",
          authToken: true,
          http: {
            url: "https://server.example.test",
            username: "opencode",
            password: "secret",
          },
        },
      ],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "opencode",
      password: "secret",
    })
    expect(list[0]?.type === "http" ? list[0].authToken : false).toBe(true)
    expect(ServerConnection.key(list[0]!) as string).toBe("https://server.example.test")
  })

  test("uses stable keys for extra-agent connections across port changes", () => {
    const first = ServerConnection.key({
      type: "http",
      integration: "genericagent",
      http: { url: "http://127.0.0.1:40101" },
    })
    const next = ServerConnection.key({
      type: "http",
      integration: "genericagent",
      http: { url: "http://127.0.0.1:40102" },
    })

    expect(first as string).toBe("extra-agent:genericagent")
    expect(next).toBe(first)
  })

  test("keeps persisted credentials when startup has no auth_token", () => {
    const list = resolveServerList({
      stored: [
        {
          url: "https://server.example.test",
          username: "opencode",
          password: "saved",
        },
      ],
      props: [{ type: "http", http: { url: "https://server.example.test" } }],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "opencode",
      password: "saved",
    })
    expect(list[0]?.type === "http" ? list[0].authToken : true).toBeUndefined()
  })
})

describe("resolveProjectsListKey", () => {
  test("collapses local sidecar and loopback urls onto the same bucket", () => {
    expect(projectsKey("sidecar")).toBe("local")
    expect(projectsKey("http://127.0.0.1:4096")).toBe("local")
    expect(projectsKey("http://localhost:4096")).toBe("local")
  })

  test("prefers the resolved current connection over a stale active key", () => {
    expect(
      resolveProjectsListKey({
        active: "https://stale.example.test",
        currentKey: "sidecar",
      }),
    ).toBe("local")
  })

  test("uses extra-agent integration as the list key while browsing that domain", () => {
    expect(
      resolveProjectsListKey({
        active: "extra-agent:openclaw",
        currentKey: "extra-agent:openclaw",
        currentIntegration: "openclaw",
      }),
    ).toBe("openclaw")
  })

  test("falls back to active when current is missing", () => {
    expect(resolveProjectsListKey({ active: "sidecar" })).toBe("local")
    expect(resolveProjectsListKey({ active: "https://remote.example.test" })).toBe("https://remote.example.test")
  })
})
