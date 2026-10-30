import { expect, test } from "bun:test"
import type { SessionMessagePage } from "@/context/global-sync/session-messages"
import { shareMessages } from "./session-share-model"

test("exports only the problem from a non-synthetic math initialization prompt", () => {
  const page = {
    session: [{ id: "user", role: "user" }],
    part: [
      {
        id: "user",
        part: [
          {
            type: "text",
            text: "Use the math-initialize skill to initialize or reconnect this Math Mode project.\nPrivate path /secret\n\nProblem:\nProve the theorem.\n\nInitialization contract:\nDo not share this contract.",
          },
        ],
      },
    ],
    complete: true,
  } as SessionMessagePage
  expect(shareMessages([page])[0].markdown).toBe("Prove the theorem.")
})

test("excludes assistants belonging to a reverted user even with inconsistent timestamps", () => {
  const page = {
    session: [
      { id: "user", role: "user", time: { created: 2 } },
      { id: "assistant", role: "assistant", parentID: "user", time: { created: 1 } },
    ],
    part: ["user", "assistant"].map((id) => ({ id, part: [{ type: "text", text: "reverted" }] })),
    complete: true,
  } as SessionMessagePage
  expect(shareMessages([page], "user")).toEqual([])
})
