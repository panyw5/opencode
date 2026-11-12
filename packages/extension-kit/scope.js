import fs from "node:fs"
import path from "node:path"

// CSS selector scoping for web extension builds.
//
// The host wraps every extension-rendered surface in
// `<div data-extension="<id>">` (file viewers in packages/app
// src/pages/session/file-tabs.tsx, panels in packages/app
// src/extensions/panel-content.tsx). The PostCSS plugin built here rewrites
// each selector in the extension bundle so it only matches inside that mount,
// which keeps extension CSS from leaking into host DOM.

// Mirrors the extension id pattern in packages/opencode/src/extension/schema.ts.
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/

// At-rules whose inner rules must keep their original meaning: @keyframes
// steps and @font-face/`@property`/... blocks carry no element selectors, and
// scoping or dropping them would break animations, fonts and registrations.
const UNSCOPED_AT_RULE_PATTERN =
  /^(?:-(?:webkit|moz|ms|o)-)?(?:keyframes|font-face|font-feature-values|property|counter-style|page|scope)$/

/** Validate an extension id and return the attribute selector scoping to it. */
export function extensionScopeSelector(id) {
  if (typeof id !== "string" || !EXTENSION_ID_PATTERN.test(id)) {
    throw new Error(`OpenCode extension scope requires a valid extension id, got: ${JSON.stringify(id)}`)
  }
  return `[data-extension="${id}"]`
}

/**
 * Rewrite one selector so it only matches inside the extension mount.
 *
 * - `:root` / `:host` become the mount root itself, so extension-defined CSS
 *   custom properties keep working without touching the host document root.
 * - `html` / `body` are mapped onto the mount root (optionally followed by a
 *   descendant part); a bare `html body` reset becomes just the mount root.
 * - Everything else is prefixed with the scope as a descendant selector.
 */
export function scopeSelector(selector, scope) {
  const raw = selector.trim()
  if (raw === "") return selector

  const rootLike = /^:(root|host)((?:\.|#|\[|:|\s).+)?$/.exec(raw)
  if (rootLike) return scope + (rootLike[2] ?? "")

  const elementRoot = /^(html|body)(?![\w-])((?:\.|#|\[|:).+)?$/.exec(raw)
  if (elementRoot) return scope + (elementRoot[2] ?? "")

  const descendantRoot = /^(html|body)\s+(.+)$/.exec(raw)
  if (descendantRoot) {
    const rest = descendantRoot[2]
    if (/^(?:html|body)(?![\w-])(?:\s+(?:html|body)(?![\w-]))*$/.test(rest)) return scope
    return `${scope} ${rest}`
  }

  return `${scope} ${raw}`
}

/** True when a rule lives inside an at-rule that must not be rewritten. */
export function insideUnscopedAtRule(rule) {
  let parent = rule.parent
  while (parent) {
    if (parent.type === "atrule" && UNSCOPED_AT_RULE_PATTERN.test(parent.name)) return true
    parent = parent.parent
  }
  return false
}

/**
 * PostCSS plugin (plain object form, so nothing has to be imported to use it)
 * that prefixes every selector with the extension mount scope.
 */
export function extensionScopePostcssPlugin(id) {
  const scope = extensionScopeSelector(id)
  return {
    postcssPlugin: "opencode-extension-scope",
    Rule(rule) {
      if (insideUnscopedAtRule(rule)) return
      const next = rule.selectors.map((selector) => scopeSelector(selector, scope))
      if (next.some((selector, index) => selector !== rule.selectors[index])) rule.selectors = next
    },
  }
}

/**
 * Resolve the extension id used for scoping: an explicit `scope` option wins,
 * otherwise `opencode.id` from the extension package.json.
 */
export function scopeExtensionID(options = {}) {
  const override = options.scope
  if (typeof override === "string" && override.trim() !== "") {
    const trimmed = override.trim()
    if (!EXTENSION_ID_PATTERN.test(trimmed)) {
      throw new Error(`OpenCode extension scope id is invalid: ${trimmed}`)
    }
    return trimmed
  }

  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.resolve(options.cwd ?? process.cwd(), "package.json"), "utf8"))
  } catch {
    throw new Error(
      "OpenCode extension build cannot read package.json: pass { scope } to extensionKit() or run the build from the extension package directory",
    )
  }
  const id = pkg?.opencode?.id
  if (typeof id !== "string" || !EXTENSION_ID_PATTERN.test(id)) {
    throw new Error(
      "OpenCode extension build requires opencode.id in package.json (or pass { scope } to extensionKit())",
    )
  }
  return id
}
