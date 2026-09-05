import { describe, expect, test } from "bun:test"
import type { SshServersState } from "@opencode-ai/app/ssh/types"
import { readySshConnections } from "./connections"

function state(runtimes: Array<{ target: string; kind: string; url?: string }>): SshServersState {
  return {
    probes: {},
    opencodeChecks: {},
    servers: runtimes.map(({ target, kind, url }) => ({
      config: { id: `ssh:${target}`, target, autoStart: true },
      runtime:
        kind === "ready"
          ? { kind: "ready" as const, url: url ?? "http://127.0.0.1:4000", username: "opencode", password: "secret" }
          : kind === "starting"
            ? { kind: "starting" as const }
            : kind === "failed"
              ? { kind: "failed" as const, message: "boom" }
              : { kind: "stopped" as const },
    })),
    job: null,
  }
}

describe("readySshConnections", () => {
  test("maps ready servers to ssh connections", () => {
    const connections = readySshConnections(
      state([{ target: "amy@host", kind: "ready", url: "http://127.0.0.1:4123" }]),
    )
    expect(connections).toEqual([
      {
        displayName: "amy@host",
        type: "ssh",
        host: "amy@host",
        http: {
          url: "http://127.0.0.1:4123",
          username: "opencode",
          password: "secret",
        },
      },
    ])
  })

  test("skips servers that are not ready", () => {
    const connections = readySshConnections(
      state([
        { target: "a@host", kind: "starting" },
        { target: "b@host", kind: "failed" },
        { target: "c@host", kind: "stopped" },
      ]),
    )
    expect(connections).toEqual([])
  })

  test("returns empty for undefined state", () => {
    expect(readySshConnections(undefined)).toEqual([])
  })
})
