const ID = "[A-Za-z0-9._~-]+"
const READS = [
  /^\/project$/,
  /^\/project\/current$/,
  /^\/path$/,
  /^\/vcs$/,
  /^\/config$/,
  /^\/config\/providers$/,
  /^\/global\/config$/,
  /^\/provider$/,
  /^\/session$/,
  /^\/session\/status$/,
  new RegExp(`^/session/${ID}$`),
  new RegExp(`^/session/${ID}/children$`),
  new RegExp(`^/session/${ID}/todo$`),
  new RegExp(`^/session/${ID}/diff$`),
  new RegExp(`^/session/${ID}/message$`),
  new RegExp(`^/session/${ID}/message/${ID}$`),
  new RegExp(`^/session/${ID}/user-message-index$`),
  new RegExp(`^/session/${ID}/hooks$`),
  /^\/experimental\/session$/,
  /^\/agent$/,
  /^\/command$/,
  /^\/skill$/,
  /^\/permission$/,
  /^\/question$/,
  /^\/scheduled-task$/,
  new RegExp(`^/scheduled-task/${ID}$`),
  new RegExp(`^/scheduled-task/${ID}/run$`),
  /^\/project-task$/,
  new RegExp(`^/project-task/${ID}$`),
  new RegExp(`^/project-task/${ID}/detail$`),
  /^\/mcp$/,
  /^\/lsp$/,
  /^\/file$/,
  /^\/file\/content$/,
  /^\/file\/status$/,
  /^\/event$/,
  /^\/global\/event$/,
  /^\/global\/health$/,
]

const WRITES = [
  { method: "POST", path: /^\/session$/ },
  { method: "POST", path: new RegExp(`^/session/${ID}/message$`) },
  { method: "POST", path: new RegExp(`^/session/${ID}/prompt_async$`) },
  { method: "POST", path: new RegExp(`^/session/${ID}/abort$`) },
  // The current permission dock uses the session-scoped SDK endpoint.
  { method: "POST", path: new RegExp(`^/session/${ID}/permissions/${ID}$`) },
  { method: "POST", path: new RegExp(`^/permission/${ID}/reply$`) },
  { method: "POST", path: new RegExp(`^/question/${ID}/reply$`) },
  { method: "POST", path: new RegExp(`^/question/${ID}/reject$`) },
]

export type RemoteRoutePolicy = "read" | "write" | "deny"

export function routePolicy(method: string | undefined, path: string): RemoteRoutePolicy {
  const verb = (method ?? "").toUpperCase()
  if (verb === "GET" || verb === "HEAD") return READS.some((route) => route.test(path)) ? "read" : "deny"
  if (WRITES.some((route) => route.method === verb && route.path.test(path))) return "write"
  return "deny"
}

export type RedactionMode = "config" | "catalog"

const CONFIG_PRIVATE_CONTAINERS = new Set([
  "provider",
  "providers",
  "mcp",
  "lsp",
  "plugin",
  "plugins",
  "headers",
  "header",
  "env",
  "environment",
  "options",
  "settings",
  "request",
  "credentials",
  "credential",
])
const CATALOG_PRIVATE_CONTAINERS = new Set([
  "headers",
  "header",
  "env",
  "environment",
  "options",
  "settings",
  "request",
  "credentials",
  "credential",
])
const PROVIDER_INFO_FIELDS = ["id", "name", "source"]
const PROVIDER_MODEL_FIELDS = [
  "id",
  "providerID",
  "name",
  "family",
  "capabilities",
  "cost",
  "limit",
  "status",
  "release_date",
  "variants",
  "limitSource",
]

export function redactSensitive(value: unknown, mode: RedactionMode = "config"): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, mode))
  if (typeof value === "string") return redactUrl(value)
  if (!value || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  if (mode === "catalog" && isProviderInfo(record)) return redactProviderInfo(record)
  if (mode === "catalog" && isProviderModel(record)) return redactProviderModel(record)

  const output: Record<string, unknown> = {}
  const privateContainers = mode === "config" ? CONFIG_PRIVATE_CONTAINERS : CATALOG_PRIVATE_CONTAINERS
  for (const [key, item] of Object.entries(record)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase()
    if (privateContainers.has(normalized) || isSensitiveName(normalized)) continue
    output[key] = redactSensitive(item, mode)
  }
  return output
}

function isProviderInfo(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    !!value.models &&
    typeof value.models === "object" &&
    !Array.isArray(value.models)
  )
}

function isProviderModel(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.providerID === "string" &&
    typeof value.name === "string" &&
    !!value.capabilities &&
    !!value.limit
  )
}

function redactProviderInfo(value: Record<string, unknown>): Record<string, unknown> {
  const output = pick(value, PROVIDER_INFO_FIELDS)
  if (value.models && typeof value.models === "object" && !Array.isArray(value.models)) {
    output.models = Object.fromEntries(
      Object.entries(value.models as Record<string, unknown>).flatMap(([id, model]) => {
        if (!model || typeof model !== "object" || Array.isArray(model)) return []
        return [[id, redactProviderModel(model as Record<string, unknown>)]]
      }),
    )
  }
  return output
}

function redactProviderModel(value: Record<string, unknown>): Record<string, unknown> {
  const output = pick(value, PROVIDER_MODEL_FIELDS)
  for (const [key, item] of Object.entries(output)) output[key] = redactSensitive(item, "catalog")
  return output
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const key of keys) if (Object.hasOwn(value, key)) output[key] = value[key]
  return output
}

function isSensitiveName(normalized: string): boolean {
  return (
    normalized === "key" ||
    normalized.endsWith("key") ||
    /token|secret|password|credential|authorization|auth|signature|privatekey/.test(normalized)
  )
}

function redactUrl(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveName(key.replace(/[^a-z0-9]/gi, "").toLowerCase())) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return "[redacted URL]"
  }
}
