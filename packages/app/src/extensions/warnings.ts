// Maps stable server warning codes (ExtensionInfo.warnings, install preview
// warnings) to localized labels. Codes are emitted by
// packages/opencode/src/extension/manifest.ts and registry.ts — for example
// "web.apiVersion:2" when the declared web API version was dropped because
// this host only implements web.apiVersion 1, or "server.isolation:inline"
// when a managed (non-path) install still declares the development-only
// inline backend. Unknown codes render verbatim so a newer server stays
// understandable on an older app.
export function extensionWarningLabel(warning: string):
  | {
      key:
        | "config.extensions.warnings.webApiVersion"
        | "config.extensions.warnings.serverApiVersion"
        | "config.extensions.warnings.inlineIsolation"
      params?: Record<string, string | number | boolean>
    }
  | undefined {
  const web = /^web\.apiVersion:(.+)$/.exec(warning)
  if (web) {
    return {
      key: "config.extensions.warnings.webApiVersion",
      params: { version: web[1]! },
    }
  }
  const server = /^server\.apiVersion:(.+)$/.exec(warning)
  if (server) {
    return {
      key: "config.extensions.warnings.serverApiVersion",
      params: { version: server[1]! },
    }
  }
  if (warning === "server.isolation:inline") {
    return { key: "config.extensions.warnings.inlineIsolation" }
  }
}
