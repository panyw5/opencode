export function isTrustedRemoteRendererUrl(value: unknown, devUrl = process.env.ELECTRON_RENDERER_URL): boolean {
  if (typeof value !== "string" || !URL.canParse(value)) return false
  const candidate = new URL(value)
  if (candidate.username || candidate.password) return false
  if (candidate.protocol === "oc:" && candidate.host === "renderer") return true
  if (!devUrl || !URL.canParse(devUrl)) return false
  const development = new URL(devUrl)
  return development.origin !== "null" && candidate.origin === development.origin
}
