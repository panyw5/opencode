import { describe, expect, test } from "bun:test"
import { reconcileVerifierModelDraft } from "./math-verifier-model"

describe("verifier model draft reconciliation", () => {
  test("keeps an unsaved user selection during swarm polling", () => {
    expect(
      reconcileVerifierModelDraft({
        draft: "test/new-verifier",
        persisted: "test/old-verifier",
        nextPersisted: "test/old-verifier",
      }),
    ).toEqual({
      model: "test/new-verifier",
      persistedModel: "test/old-verifier",
      changed: false,
      preservedDraft: false,
    })
  })

  test("adopts a newly persisted model after save", () => {
    expect(
      reconcileVerifierModelDraft({
        draft: "test/new-verifier",
        persisted: "test/old-verifier",
        nextPersisted: "test/new-verifier",
      }),
    ).toEqual({
      model: "test/new-verifier",
      persistedModel: "test/new-verifier",
      changed: true,
      preservedDraft: false,
    })
  })

  test("preserves a different draft when project state changes externally", () => {
    expect(
      reconcileVerifierModelDraft({
        draft: "test/draft-verifier",
        persisted: "test/old-verifier",
        nextPersisted: "test/external-verifier",
      }),
    ).toEqual({
      model: "test/draft-verifier",
      persistedModel: "test/external-verifier",
      changed: true,
      preservedDraft: true,
    })
  })
})
