// Maps stable server warning codes (ExtensionInfo.warnings) to localized
// labels. Codes are emitted by packages/opencode/src/extension/manifest.ts —
// for example "web.apiVersion:2" when the declared web API version was dropped
// because this host only implements web.apiVersion 1. Unknown codes render
// verbatim so a newer server stays understandable on an older app.
export function extensionWarningLabel(warning: string) {
  const match = /^web\.apiVersion:(.+)$/.exec(warning)
  if (match) {
    return {
      key: "config.extensions.warnings.webApiVersion" as const,
      params: { version: match[1]! },
    }
  }
}
