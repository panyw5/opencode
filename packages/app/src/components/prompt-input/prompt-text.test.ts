import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { promptText } from "./prompt-text"

describe("prompt text expansion", () => {
  test("expands the IM pill into safe channel sending guidance", () => {
    const prompt: Prompt = [
      { type: "text", content: "Please notify me: ", start: 0, end: 18 },
      { type: "im", content: "@IM", start: 18, end: 21 },
    ]

    expect(promptText(prompt)).toBe(
      "Please notify me: @IM\n\nIM channel reference: if IM sending is needed, use im_list to verify an available IM channel, then use im_send({ channelName, text }) to send to its configured recipient. If unavailable, do not invent a channel name or recipient.",
    )
  })

  test("includes selected channel and bot name in the guidance", () => {
    const prompt: Prompt = [
      { type: "im", content: "@work-feishu · Alice", channelName: "work-feishu", botName: "Alice", start: 0, end: 20 },
    ]
    expect(promptText(prompt)).toContain("the work-feishu channel (bot: Alice)")
  })
})
