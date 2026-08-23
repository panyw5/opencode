const BROKEN_CONSOLE_CODES = new Set(["EPIPE", "EIO"])

/**
 * A detached development terminal can report either EPIPE or EIO when the
 * Electron main process writes to stdout. Neither should crash the app; file
 * logging remains available after the console transport is disabled.
 */
export function brokenConsoleCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return
  const code = error.code
  return typeof code === "string" && BROKEN_CONSOLE_CODES.has(code) ? code : undefined
}
