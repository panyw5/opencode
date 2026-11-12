/** Best-effort cache-directory attribution, not proof of the original extension ID. */
export function extensionFromStack(stack?: string): string | undefined {
  if (!stack) return
  for (const frame of stack.split("\n").slice(1)) {
    if (!/^\s*at\s/.test(frame)) continue
    const id = /(?:^|[\\/])extension-modules[\\/]([A-Za-z0-9._-]{1,120})[\\/]/.exec(frame)?.[1]
    if (id && id !== "." && id !== "..") return id
  }
}
