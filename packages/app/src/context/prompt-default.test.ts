import { describe, expect, test } from "bun:test"
import { createStore, reconcile } from "solid-js/store"
import { createEmptyPrompt, DEFAULT_PROMPT } from "./prompt-default"

describe("prompt default isolation", () => {
  test("the template and its text part cannot be mutated by shallow copies", () => {
    expect(Object.isFrozen(DEFAULT_PROMPT)).toBe(true)
    expect(Object.isFrozen(DEFAULT_PROMPT[0])).toBe(true)
    const shallow = DEFAULT_PROMPT.slice()
    expect(() => Object.assign(shallow[0]!, { content: "foreign draft" })).toThrow()
    expect(DEFAULT_PROMPT[0]).toMatchObject({ content: "", start: 0, end: 0 })
  })

  test("independent input stores never share live default objects", () => {
    const [main, setMain] = createStore({ prompt: createEmptyPrompt() })
    const [quick, setQuick] = createStore({ prompt: createEmptyPrompt() })
    expect(main.prompt[0]).not.toBe(quick.prompt[0])
    setQuick("prompt", reconcile([{ type: "text", content: "quick draft", start: 0, end: 11 }]))
    expect(main.prompt[0]).toMatchObject({ content: "" })
    setMain("prompt", reconcile([{ type: "text", content: "main draft", start: 0, end: 10 }]))
    expect(quick.prompt[0]).toMatchObject({ content: "quick draft" })
    setMain("prompt", createEmptyPrompt())
    expect(main.prompt[0]).toMatchObject({ content: "" })
    expect(quick.prompt[0]).toMatchObject({ content: "quick draft" })
    expect(DEFAULT_PROMPT[0]).toMatchObject({ content: "" })
  })
})
