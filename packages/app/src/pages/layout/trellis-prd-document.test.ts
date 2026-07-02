import { describe, expect, test } from "bun:test"
import { commitPrdDocumentSave, createPrdDocumentState, revertPrdDocumentDraft } from "./trellis-prd-document"

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
})
