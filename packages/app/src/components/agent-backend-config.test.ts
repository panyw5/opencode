import { expect, test } from "bun:test"
import { parseAcpCommand, parseAcpEnvironment } from "./agent-backend-config"

test("ACP commands preserve argv boundaries and never accept shell text", () => {
  expect(parseAcpCommand('["/Applications/My Adapter/bin/agent", "--config", "two words;not a shell"]')).toEqual([
    "/Applications/My Adapter/bin/agent",
    "--config",
    "two words;not a shell",
  ])
  for (const value of ['"npx adapter"', "[]", '[""]', '["adapter",4]', "{}", "not json"])
    expect(() => parseAcpCommand(value)).toThrow()
})
test("ACP environment requires string-valued JSON and does not coerce invalid inputs", () => {
  expect(parseAcpEnvironment('{"CONFIG_HOME":"/tmp/my dir"}')).toEqual({ CONFIG_HOME: "/tmp/my dir" })
  expect(parseAcpEnvironment("")).toEqual({})
  for (const value of ["null", "[]", '{"TOKEN":123}', '{"ENV":{}}']) expect(() => parseAcpEnvironment(value)).toThrow()
})
