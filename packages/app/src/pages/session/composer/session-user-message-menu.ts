export function canShowUserMessageMenuItems(input: { loading: boolean; complete: boolean }) {
  return input.complete && !input.loading
}
