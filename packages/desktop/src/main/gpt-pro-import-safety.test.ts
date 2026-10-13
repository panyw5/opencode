import { expect, test } from "bun:test"
import { GPT_PRO_PARTITION } from "@opencode-ai/util/gpt-pro"
import { inspectGptProImportSafety } from "./gpt-pro-import-safety"

test("manual drafts and generation block replacement without logging their contents", async () => {
  const logs: string[] = []
  const views = ["draft", "generating", "idle"].map((pageID) => ({
    pageID,
    partition: pageID,
    profileID: GPT_PRO_PARTITION,
    url: "https://chatgpt.com/",
    title: "ChatGPT",
    loading: false,
    shared: false,
    epoch: 1,
  }))
  const result = await inspectGptProImportSafety(
    {
      getState: () => views,
      cdp: (id: string) => ({
        evaluate: async () => ({
          draft: id === "draft" ? "PRIVATE_MANUAL_DRAFT" : "",
          generating: id === "generating",
        }),
      }),
    } as never,
    (line) => logs.push(line),
  )
  expect(result.blockers.map((item) => item.id)).toEqual(["browser:draft", "browser:generating"])
  expect(logs.join("\n")).not.toContain("PRIVATE_MANUAL_DRAFT")
})
test("loading pages fail closed while unrelated profiles are ignored", async () => {
  const views = [
    {
      pageID: "loading",
      partition: "loading",
      profileID: GPT_PRO_PARTITION,
      url: "https://chatgpt.com/",
      title: "ChatGPT",
      loading: true,
      shared: false,
      epoch: 1,
    },
    {
      pageID: "other",
      partition: "other",
      profileID: "unrelated",
      url: "https://chatgpt.com/",
      title: "Other",
      loading: true,
      shared: false,
      epoch: 1,
    },
  ]
  const result = await inspectGptProImportSafety({ getState: () => views, cdp: () => undefined }, () => {})
  expect(result.blockers).toHaveLength(1)
  expect(result.blockers[0].id).toBe("browser:loading")
})
