export const PRESENTATION_SOURCE_EVENT = "opencode:presentation-source"

export type PresentationSourceRequest = {
  sessionID: string
  path: string
}

export function openPresentationSource(input: PresentationSourceRequest) {
  window.dispatchEvent(new CustomEvent<PresentationSourceRequest>(PRESENTATION_SOURCE_EVENT, { detail: input }))
}
