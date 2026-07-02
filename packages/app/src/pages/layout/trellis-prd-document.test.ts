import { describe, expect, test } from "bun:test"
import {
  applyPrdDocumentPairEdit,
  commitPrdDocumentSave,
  createPrdDocumentState,
  revertPrdDocumentDraft,
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

  test("cancel restores the latest saved content instead of the original load", () => {
    const saved = commitPrdDocumentSave({
      ...createPrdDocumentState("# Old\n"),
      draft: "# Saved once\n",
    })

    const reverted = revertPrdDocumentDraft({
      ...saved,
      draft: "# Unsaved edit\n",
    })

    expect(reverted.savedContent).toBe("# Saved once\n")
    expect(reverted.draft).toBe("# Saved once\n")
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
