import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createGateway } from "../../src/math/gateway"
import { buildMathMcpServer, projectVerifierModel } from "../../src/math/mcp"
import { setVerifierModel } from "../../src/math/swarm"
import { stubVerifier } from "../../src/math/verifier"
import { tmpdir } from "../fixture/fixture"

async function connect(role: string, dir: string) {
  const gateway = createGateway({
    projectDir: dir,
    role,
    author: "tester",
    problemId: "P",
    verifier: stubVerifier(() => ({ verdict: "correct" })),
  })
  const server = buildMathMcpServer(gateway)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, gateway }
}

describe("math.mcp", () => {
  test("reads verifier model updates dynamically from project state", async () => {
    await using tmp = await tmpdir()
    const env = { OPENCODE_MATH_PROJECT_DIR: tmp.path }
    expect(projectVerifierModel(env)).toBeUndefined()
    setVerifierModel(tmp.path, "test/verifier-a")
    expect(projectVerifierModel(env)).toBe("test/verifier-a")
    setVerifierModel(tmp.path, "test/verifier-b")
    expect(projectVerifierModel(env)).toBe("test/verifier-b")
  })

  test("orchestrator tools/list does not include fact_submit", async () => {
    await using tmp = await tmpdir()
    const { client } = await connect("orchestrator", tmp.path)
    const listed = await client.listTools()
    const names = listed.tools.map((t) => t.name).sort()
    expect(names).toEqual(["fact_get", "fact_revoke", "fact_search", "gm_add", "gm_search"])
    expect(names).not.toContain("fact_submit")
  })

  test("worker tools/list includes fact_submit and can write a fact", async () => {
    await using tmp = await tmpdir()
    const { client } = await connect("worker", tmp.path)
    const listed = await client.listTools()
    expect(listed.tools.map((t) => t.name)).toContain("fact_submit")
    const result = await client.callTool({
      name: "fact_submit",
      arguments: { statement: "S", proof: "pf" },
    })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text
    const body = JSON.parse(text)
    expect(body.accepted).toBe(true)
    expect(body.fact_id).toBeTruthy()
    const fact = await client.callTool({ name: "fact_get", arguments: { fact_id: body.fact_id } })
    const factText = (fact.content as Array<{ type: string; text: string }>)[0]?.text
    expect(JSON.parse(factText).content).toContain("## proof")
  })

  test("orchestrator tools/call fact_submit is an MCP error (tool not registered)", async () => {
    await using tmp = await tmpdir()
    const { client } = await connect("orchestrator", tmp.path)
    let failed = false
    try {
      const result = await client.callTool({
        name: "fact_submit",
        arguments: { statement: "S", proof: "pf" },
      })
      failed = result.isError === true
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })
})
