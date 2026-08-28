import { describe, expect, test } from "bun:test"
import {
  ensureMathWorker,
  getMathWorkerTask,
  listMathDetails,
  listMathWorkers,
  stopMathWorker,
  updateMathWorkerTask,
} from "./math-worker-api"

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

  test("lists paginated Math Mode details", async () => {
    const input = fixture({ kind: "wrong", total: 29, offset: 20, limit: 20, items: [] })
    const result = await listMathDetails({
      sdk: input.sdk as never,
      platform: input.platform as never,
      parentSessionID: "parent/id",
      project: "proof swarm",
      kind: "wrong",
      offset: 20,
      limit: 20,
    })
    expect(result.total).toBe(29)
    expect(input.requests[0]?.url).toBe(
      "http://127.0.0.1:4096/session/parent%2Fid/math-details?project=proof+swarm&kind=wrong&offset=20&limit=20&directory=%2Ftmp%2Fmath+project",
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
      reEnable: true,
    })
    await stopMathWorker({
      sdk: input.sdk as never,
      platform: input.platform as never,
      parentSessionID: "parent",
      workerSessionID: "worker",
      force: false,
    })
    await getMathWorkerTask({
      sdk: input.sdk as never,
      platform: input.platform as never,
      parentSessionID: "parent",
      workerSessionID: "worker",
      project: "custom-swarm",
    })
    await updateMathWorkerTask({
      sdk: input.sdk as never,
      platform: input.platform as never,
      parentSessionID: "parent",
      workerSessionID: "worker",
      project: "custom-swarm",
      task: "# redirected",
    })
    expect(input.requests.map((item) => item.init?.method)).toEqual(["POST", "POST", undefined, "PUT"])
    expect(input.requests[0]?.url).toContain("/math-workers/worker/ensure?project=custom-swarm&directory=")
    expect(input.requests[0]?.init?.body).toBe('{"reEnable":true}')
    expect(input.requests[1]?.url).toContain("/math-workers/worker/stop")
    expect(input.requests[1]?.init?.body).toBe('{"force":false}')
    expect(input.requests[2]?.url).toContain("/math-workers/worker/task?project=custom-swarm&directory=")
    expect(input.requests[3]?.init?.body).toBe('{"task":"# redirected"}')
  })
})
