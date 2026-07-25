import { describe, expect, test } from "bun:test"
import {
  applyPrdDocumentPairEdit,
  commitPrdDocumentSave,
  createPrdDocumentState,
  prdPreviewTitle,
} from "./trellis-prd-document"

describe("trellis prd document", () => {
  test("save promotes the current draft to the saved preview content", () => {
    const initial = createPrdDocumentState("# Old\n")
    const saved = commitPrdDocumentSave({
      ...initial,
      draft: "# New\n",
    })

    expect(saved.savedContent).toBe("# New\n")
    expect(saved.draft).toBe("# New\n")
  })

  test("autosave promotes the latest draft so preview uses durable content", () => {
    const autosaved = commitPrdDocumentSave({
      ...createPrdDocumentState("# Old\n"),
      draft: "# Autosaved edit\n",
    })

    expect(autosaved.savedContent).toBe("# Autosaved edit\n")
    expect(autosaved.draft).toBe("# Autosaved edit\n")
  })

  test("uses the task name rather than its description for the preview title", () => {
    expect(prdPreviewTitle("07-22-global-session-content-search")).toBe("07-22-global-session-content-search")
  })

  test("auto-pairs common brackets and quotes in PRD edits", () => {
    expect(
      applyPrdDocumentPairEdit({
        text: "Goal",
        start: 0,
        end: 4,
        key: "[",
      }),
    ).toEqual({
      text: "[Goal]",
      start: 1,
      end: 5,
    })

    expect(
      applyPrdDocumentPairEdit({
        text: '""',
        start: 1,
        end: 1,
        key: '"',
      }),
    ).toEqual({
      text: '""',
      start: 2,
      end: 2,
    })

    expect(
      applyPrdDocumentPairEdit({
        text: "()",
        start: 1,
        end: 1,
        key: "Backspace",
      }),
    ).toEqual({
      text: "",
      start: 0,
      end: 0,
    })
  })
})
