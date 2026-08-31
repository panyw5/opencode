import { describe, expect, spyOn, test } from "bun:test"
import { logger, sanitizeMetric } from "../src/routes/zen/util/logger"

describe("zen logger", () => {
  test("drops identifiers and provider payload fields from metrics", () => {
    expect(
      sanitizeMetric({
        session: "ses_secret",
        request: "req_secret",
        workspace: "wrk_secret",
        api_key: "key_secret",
        "error.response": '{"prompt":"secret"}',
        "error.message": "provider leaked a URL",
        "error.cause": "database details",
        "llm.error.message": "provider body",
        authorization: "Bearer secret",
        credentials: "provider secret",
        body: '{"prompt":"secret"}',
        part: "data: secret",
        session_id: "ses_alias",
        workspaceID: "wrk_alias",
        apiKey: "key_alias",
        payload: "raw provider data",
        provider_api_key: "key_alias_2",
        access_token: "token_alias",
        provider: "anthropic",
        response_length: 42,
        is_stream: true,
        nested: { secret: true },
      }),
    ).toEqual({
      provider: "anthropic",
      response_length: 42,
      is_stream: true,
    })
  })

  test("does not emit an empty metric after sanitization", () => {
    const output = spyOn(console, "log").mockImplementation(() => {})
    try {
      logger.metric({ session: "ses_secret", workspace: "wrk_secret" })
      expect(output).not.toHaveBeenCalled()
    } finally {
      output.mockRestore()
    }
  })
})
