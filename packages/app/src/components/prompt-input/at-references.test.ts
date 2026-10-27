import { describe, expect, test } from "bun:test"
import { atCategories, atReferenceText, cycleAtCategory, inAtCategory, projectSessions } from "./at-references"

describe("at references", () => {
  test("Tab cycles through every category and wraps in either direction", () => {
    for (let index = 0; index < atCategories.length; index++) {
      const category = atCategories[index]
      expect(cycleAtCategory(category)).toBe(atCategories[(index + 1) % atCategories.length])
      expect(cycleAtCategory(category, true)).toBe(
        atCategories[(index + atCategories.length - 1) % atCategories.length],
      )
    }
  })
  test("all retains every existing source", () => {
    for (const type of ["file", "agent", "consult", "im", "session", "projectTask", "scheduledTask"]) {
      expect(inAtCategory(type, "all")).toBe(true)
    }
  })
  test("categories isolate sources", () => {
    expect(inAtCategory("consult", "external")).toBe(true)
    expect(inAtCategory("agent", "external")).toBe(false)
    for (const category of atCategories.slice(2)) {
      expect(inAtCategory(category, category)).toBe(true)
      expect(inAtCategory("file", category)).toBe(false)
    }
  })
  test("references contain literal names and IDs", () => {
    for (const type of ["session", "projectTask", "scheduledTask"] as const) {
      expect(atReferenceText({ type, id: "id-1", name: 'name "quoted"', display: "" })).toBe(
        `@${type} "name \\"quoted\\"" (ID: id-1) `.replaceAll('\\\\"', '\\"'),
      )
    }
  })
  test("sessions from other projects are excluded", () => {
    expect(projectSessions([{ projectID: "a" }, { projectID: "b" }], "a")).toEqual([{ projectID: "a" }])
  })
})
