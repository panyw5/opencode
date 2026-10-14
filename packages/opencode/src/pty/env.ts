export function prepare(
  input: { env?: NodeJS.ProcessEnv; plugin?: NodeJS.ProcessEnv; inherit?: boolean } = {},
): Record<string, string> {
  const result = Object.fromEntries(
    Object.entries({ ...(input.inherit === false ? {} : process.env), ...input.env, ...input.plugin }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  result.TERM = "xterm-256color"
  result.OPENCODE_TERMINAL = "1"

  if (process.platform === "win32") {
    result.LC_ALL = "C.UTF-8"
    result.LC_CTYPE = "C.UTF-8"
    result.LANG = "C.UTF-8"
  }
  return result
}

export * as Env from "./env"
