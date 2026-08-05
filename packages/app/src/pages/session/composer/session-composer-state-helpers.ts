export const todoState = (input: {
  count: number
  done: boolean
  live: boolean
}): "hide" | "open" | "close" => {
  if (input.count === 0) return "hide"
  // Incomplete todos always keep the dock open so the user can track progress.
  if (!input.done) return "open"
  // All todos finished: hide the dock when idle, animate closed while still live.
  // Do NOT wipe the store — completed todos must remain visible in the float /
  // project-task dashboard which read the same cache.
  if (!input.live) return "hide"
  return "close"
}
