export function reconcileVerifierModelDraft(input: {
  draft: string
  persisted: string
  nextPersisted: string
}): { model: string; persistedModel: string; changed: boolean; preservedDraft: boolean } {
  if (!input.nextPersisted || input.nextPersisted === input.persisted) {
    return {
      model: input.draft,
      persistedModel: input.persisted,
      changed: false,
      preservedDraft: false,
    }
  }
  const draftUnchanged =
    !input.draft || input.draft === input.persisted || input.draft === input.nextPersisted
  return {
    model: draftUnchanged ? input.nextPersisted : input.draft,
    persistedModel: input.nextPersisted,
    changed: true,
    preservedDraft: !draftUnchanged,
  }
}
