import { expect, test } from "bun:test"
import { buildRequestParts } from "./build-request-parts"

test("Pro background choice is preserved in the request and optimistic text part", () => {
  for (const background of [true, false, undefined]) {
    const result = buildRequestParts({ prompt: [], context: [], images: [], text: "Question", messageID: "msg_test", sessionID: "ses_test", sessionDirectory: "/repo", gptProBackground: background })
    const part = result.requestParts[0]
    const optimistic = result.optimisticParts[0]
    expect(part.type).toBe("text")
    if (part.type === "text" && optimistic.type === "text") {
      expect(part.metadata?.gptProBackground).toBe(background)
      expect(optimistic.metadata?.gptProBackground).toBe(background)
    }
  }
})
