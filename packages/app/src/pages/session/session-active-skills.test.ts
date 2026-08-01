import { describe, expect, test } from "bun:test"
import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2/client"
import { collectSessionActiveSkills } from "./session-active-skills"

const assistant = (id: string) =>
  ({
    id,
    sessionID: "ses_1",
    role: "assistant",
    parentID: "msg_user",
    time: { created: 1, completed: 2 },
    agent: "build",
    model: { providerID: "test", modelID: "model" },
  }) as unknown as Message

const skill = (input: { id: string; messageID: string; name?: string; status?: ToolPart["state"]["status"] }) => {
  const status = input.status ?? "completed"
  return {
    id: input.id,
    sessionID: "ses_1",
    messageID: input.messageID,
    type: "tool",
    callID: input.id,
    tool: "skill",
    state:
      status === "completed"
        ? {
            status,
            input: input.name ? { name: input.name } : {},
            output: "",
            title: "Loaded skill",
            metadata: {},
            time: { start: 1, end: 2 },
          }
        : {
            status,
            input: input.name ? { name: input.name } : {},
            ...(status === "error" ? { error: "failed" } : {}),
            ...(status === "running" ? { title: "Loading skill", time: { start: 1 } } : {}),
          },
  } as ToolPart
}

describe("collectSessionActiveSkills", () => {
  test("returns completed skill loads in first-activation order without duplicates", () => {
    const messages = [assistant("msg_1"), assistant("msg_2")]
    const skills = collectSessionActiveSkills({
      messages,
      parts: {
        msg_1: [skill({ id: "part_1", messageID: "msg_1", name: "before-dev" })],
        msg_2: [
          skill({ id: "part_2", messageID: "msg_2", name: "before-dev" }),
          skill({ id: "part_3", messageID: "msg_2", name: "check" }),
        ],
      },
    })

    expect(skills).toEqual(["before-dev", "check"])
  })

  test("ignores incomplete, failed, unnamed, and non-skill tool calls", () => {
    const messages = [assistant("msg_1")]
    const skills = collectSessionActiveSkills({
      messages,
      parts: {
        msg_1: [
          skill({ id: "part_1", messageID: "msg_1", name: "pending", status: "running" }),
          skill({ id: "part_2", messageID: "msg_1", name: "failed", status: "error" }),
          skill({ id: "part_3", messageID: "msg_1" }),
          {
            ...skill({ id: "part_4", messageID: "msg_1", name: "not-a-skill" }),
            tool: "shell",
          } as Part,
        ],
      },
    })

    expect(skills).toEqual([])
  })
})
