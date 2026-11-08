export function parseAcpCommand(value: string): string[] {
  const command: unknown = JSON.parse(value)
  if (!Array.isArray(command) || !command.length || command.some((item) => typeof item !== "string" || !item.trim()))
    throw new Error("Command must be a nonempty JSON array of strings")
  return command as string[]
}

export function parseAcpEnvironment(value: string): Record<string, string> {
  const env: unknown = JSON.parse(value || "{}")
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    Object.values(env).some((item) => typeof item !== "string")
  )
    throw new Error("Environment must be a JSON object with string values")
  return env as Record<string, string>
}
