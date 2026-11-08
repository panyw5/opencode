import { expect, test } from "bun:test"
import { probeAdapter } from "../../src/agent-backend/probe"

const command = [process.execPath, `${import.meta.dir}/../fixture/acp-agent.mjs`] as [string, ...string[]]
test("ACP probe distinguishes authentication and only authenticates on an explicit method selection", async () => {
  const input = {
    advisor: "claude",
    config: { type: "acp" as const, command, env: { ACP_FIXTURE_AUTH: "1" } },
    cwd: import.meta.dir,
    signal: AbortSignal.timeout(10000),
  }
  expect(await probeAdapter(input)).toMatchObject({
    status: "authentication_required",
    authMethods: [{ id: "fixture-login" }],
  })
  expect(await probeAdapter({ ...input, authMethod: "not-advertised" })).toMatchObject({ status: "error" })
  expect(await probeAdapter({ ...input, authMethod: "fixture-login", message: true })).toMatchObject({
    status: "ready",
    response: "ACP_REPLY_1: complete",
  })
  const terminal = {
    ...input,
    config: { ...input.config, env: { ACP_FIXTURE_AUTH: "1", ACP_FIXTURE_AUTH_KIND: "terminal" } },
  }
  expect(await probeAdapter(terminal)).toMatchObject({
    status: "authentication_required",
    authMethods: [{ type: "terminal" }],
  })
  expect(await probeAdapter({ ...terminal, authMethod: "fixture-login" })).toMatchObject({ status: "error" })
  const environment = {
    ...input,
    config: { ...input.config, env: { ACP_FIXTURE_AUTH: "1", ACP_FIXTURE_AUTH_KIND: "env_var" } },
  }
  expect(await probeAdapter(environment)).toMatchObject({
    authMethods: [{ type: "env_var", environment: ["FIXTURE_SECRET"] }],
  })
})
