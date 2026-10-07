/** CSS selector scoping helpers for web extension builds (implemented in scope.js). */

/** Validate an extension id and return the `[data-extension="<id>"]` scope selector. */
export function extensionScopeSelector(id: string): string

/**
 * Rewrite one selector so it only matches inside the extension mount.
 *
 * `:root` / `:host` / `html` / `body` map onto the mount root; every other
 * selector is prefixed with the scope as a descendant selector.
 */
export function scopeSelector(selector: string, scope: string): string

/** True when a rule lives inside an at-rule that must not be rewritten. */
export function insideUnscopedAtRule(rule: unknown): boolean

/** PostCSS plugin (plain object form) that scopes every selector to the mount. */
export function extensionScopePostcssPlugin(id: string): {
  postcssPlugin: string
  Rule(rule: unknown): void
}

/** Resolve the extension id used for scoping from `scope` or `opencode.id`. */
export function scopeExtensionID(options?: { scope?: string; cwd?: string }): string
