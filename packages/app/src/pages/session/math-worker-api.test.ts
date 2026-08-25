import { describe, expect, test } from "bun:test"
import { ensureMathWorker, listMathWorkers, stopMathWorker } from "./math-worker-api"

function fixture(response: unknown) {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const sdk = { url: "http://127.0.0.1:4096", directory: "/tmp/math project" }
  const platform = {
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } })
    },
  }
  return { sdk, platform, requests }
}

describe("math-worker-api", () => {
  test("lists workers with workspace routing", async () => {
    const input = fixture([{ sessionID: "worker", alive: true, state: "running" }])
    const result = await listMathWorkers({
      sdk: input.sdk as never,
      platform: input.platform as never,
      parentSessionID: "parent/id",
    })
    expect(result[0]?.sessionID).toBe("worker")
    expect(input.requests[0]?.url).toBe(
      "http://127.0.0.1:4096/session/parent%2Fid/math-workers?directory=%2Ftmp%2Fmath+project",
    )
  })

  test("posts ensure and stop actions", async () => {
    const input = fixture({ sessionID: "worker", alive: true, state: "running" })
    await ensureMathWorker({
      sdk: input.sdk as never,
      platform: input.platform as never,
      parentSessionID: "parent",
      workerSessionID: "worker",
      project: "custom-swarm",
    })
    await stopMathWorker({
      sdk: input.sdk as never,
      platform: input.platform as never,
      parentSessionID: "parent",
      workerSessionID: "worker",
      force: false,
    })
    expect(input.requests.map((item) => item.init?.method)).toEqual(["POST", "POST"])
    expect(input.requests[0]?.url).toContain("/math-workers/worker/ensure?project=custom-swarm&directory=")
    expect(input.requests[1]?.url).toContain("/math-workers/worker/stop")
    expect(input.requests[1]?.init?.body).toBe('{"force":false}')
  })
})
