import { describe, expect, test } from "bun:test"
import {
  advanceFileViewerRevision,
  fileViewerCanMount,
  fileViewerReadsSelf,
  fileViewerSelectionRequest,
  fileViewerSwitchAllowed,
} from "./file-viewer-policy"

describe("file viewer content policy", () => {
  test("only replace self viewers bypass the loaded gate", () => {
    expect(fileViewerReadsSelf({ mode: "replace", content: "self" })).toBe(true)
    expect(fileViewerReadsSelf({ mode: "preview", content: "self" })).toBe(false)
    expect(fileViewerCanMount({ mode: "replace", content: "self" }, false)).toBe(true)
    expect(fileViewerCanMount({ mode: "preview", content: "self" }, false)).toBe(false)
    expect(fileViewerCanMount({ mode: "preview", content: "self" }, true)).toBe(true)
    expect(fileViewerCanMount({ mode: "replace" }, false)).toBe(false)
    expect(fileViewerCanMount({ mode: "replace", content: "text" }, false)).toBe(false)
    expect(fileViewerCanMount({ mode: "replace" }, true)).toBe(true)
    expect(fileViewerCanMount(undefined, true)).toBe(false)
  })

  test("self revisions ignore initial cache state and use changeRevision independently", () => {
    let state = advanceFileViewerRevision(undefined, undefined, undefined)
    state = advanceFileViewerRevision(state, "self", 42)
    expect(state.revision).toBe(0)
    state = advanceFileViewerRevision(state, "self", 42)
    expect(state.revision).toBe(0)
    state = advanceFileViewerRevision(state, "self", 43)
    expect(state.revision).toBe(1)
    state = advanceFileViewerRevision(state, "text", "cached JSON checksum")
    expect(state.revision).toBe(1)
    state = advanceFileViewerRevision(state, "text", "new checksum")
    expect(state.revision).toBe(2)
    state = advanceFileViewerRevision(state, "self", 44)
    expect(state.revision).toBe(2)
    state = advanceFileViewerRevision(state, "self", 45)
    expect(state.revision).toBe(3)
  })

  test("Source and other viewer switches reject dirty drafts", () => {
    expect(fileViewerSwitchAllowed(true, "notebook", "default")).toBe(false)
    expect(fileViewerSwitchAllowed(true, "notebook", "another-viewer")).toBe(false)
    expect(fileViewerSwitchAllowed(true, "notebook", "notebook")).toBe(true)
    expect(fileViewerSwitchAllowed(false, "notebook", "default")).toBe(true)
  })

  test("selection requests select Source once per active pending sequence", () => {
    const input = { path: "notes.ipynb", seq: 3, active: true, pending: true, hasRange: true }
    expect(fileViewerSelectionRequest(input)).toBe(true)
    const handled = { path: input.path, seq: input.seq }
    expect(fileViewerSelectionRequest({ ...input, handled })).toBe(false)
    // Re-requesting the same lines bumps selectionSeq and is a new intent.
    expect(fileViewerSelectionRequest({ ...input, seq: 4, handled })).toBe(true)
    expect(fileViewerSelectionRequest({ ...input, active: false })).toBe(false)
    expect(fileViewerSelectionRequest({ ...input, pending: false })).toBe(false)
    expect(fileViewerSelectionRequest({ ...input, hasRange: false })).toBe(false)
    expect(fileViewerSelectionRequest({ ...input, path: "other.ipynb", handled })).toBe(true)
  })
})
