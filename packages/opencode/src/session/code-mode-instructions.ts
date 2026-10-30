// Rendering and delta selection ported from anomalyco/opencode 4ba064f653.
export * as CodeModeInstructions from "./code-mode-instructions"

import { searchSignature, toolExpression } from "@opencode/codemode"
import { CodeModeCatalog } from "./code-mode-catalog"

// prettier-ignore
const prompt = (hasMoreTools: boolean) => `# Code Mode

Use the \`execute\` tool to call the tool paths listed below. These paths only work inside code you pass to \`execute\`. Separately advertised direct tools remain callable directly using their own schemas.${hasMoreTools ? " The search function also only works inside execute." : ""}

${hasMoreTools ? `The catalog is partial. Inside \`execute\`, use \`search(...)\` to find a tool, then call it by the \`path\` in the result. \`search\` is synchronous. Call it without \`await\`; it does not return a Promise. Do not guess tool names.

- ${searchSignature}` : "The catalog is complete. Do not guess tool names."}

## Available tools`

export function render(catalog: CodeModeCatalog.Summary) {
  if (catalog.total === 0)
    return "No Code Mode tools are currently available. Later Code Mode catalog updates may add or remove tools. Do not call `execute` unless there is at least one available Code Mode tool."

  const tools = catalog.namespaces.flatMap((namespace) => {
    return [CodeModeCatalog.namespaceLine(namespace), ...namespace.entries.map((entry) => entry.line)]
  })

  return `${prompt(catalog.shown < catalog.total)}

${tools.join("\n")}`
}

export function update(previous: CodeModeCatalog.Summary, current: CodeModeCatalog.Summary) {
  const replacement = `The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.

${render(current)}`
  if (current.total === 0) return replacement
  const previousComplete = previous.shown === previous.total
  const currentComplete = current.shown === current.total
  if (previousComplete !== currentComplete) return replacement

  const descriptions = diffByKey(
    previous.namespaces.filter((namespace) => namespace.description !== undefined),
    current.namespaces.filter((namespace) => namespace.description !== undefined),
    (namespace) => namespace.name,
    (before, after) => before.description !== after.description,
  )
  if (descriptions.added.length > 0 || descriptions.removed.length > 0 || descriptions.changed.length > 0)
    return replacement

  const diff = diffByKey(
    previous.namespaces.flatMap((namespace) => namespace.entries),
    current.namespaces.flatMap((namespace) => namespace.entries),
    (entry) => entry.path,
    (before, after) => before.line !== after.line,
  )
  const entriesChanged = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0

  if (!currentComplete) {
    if (entriesChanged) return replacement
    const namespaces = diffByKey(
      previous.namespaces,
      current.namespaces,
      (namespace) => namespace.name,
      (before, after) => before.count !== after.count,
    )
    const changed = namespaces.added.length > 0 || namespaces.removed.length > 0 || namespaces.changed.length > 0
    if (!changed) return replacement

    const parts = ["The Code Mode tool catalog has changed."]
    if (namespaces.added.length > 0) {
      parts.push(
        `New tool namespaces are available: ${namespaces.added
          .map((namespace) => `\`${namespace.name}\` (${namespace.count} tools)`)
          .join(", ")}.`,
      )
    }
    if (namespaces.changed.length > 0) {
      parts.push(
        `The following namespace inventories changed; search them again before relying on previous results: ${namespaces.changed
          .map((change) => `\`${change.current.name}\` now has ${change.current.count} tools`)
          .join(", ")}.`,
      )
    }
    if (namespaces.removed.length > 0) {
      parts.push(
        `The following tool namespaces are no longer available and must not be used: ${namespaces.removed
          .map((namespace) => `\`${namespace.name}\``)
          .join(", ")}.`,
      )
    }
    const delta = parts.join("\n\n")
    if (delta.length < replacement.length) return delta
    return replacement
  }

  if (!entriesChanged) return replacement
  const parts = ["The Code Mode tool catalog has changed."]
  if (diff.added.length > 0) {
    parts.push(
      [
        "New tools are available in addition to those previously listed:",
        ...diff.added.map((entry) => entry.line),
      ].join("\n"),
    )
  }
  if (diff.changed.length > 0) {
    parts.push(
      [
        "Changed tool listings supersede the previously listed ones:",
        ...diff.changed.map((change) => change.current.line),
      ].join("\n"),
    )
  }
  if (diff.removed.length > 0) {
    parts.push(
      `The following tools are no longer available and must not be called: ${diff.removed
        .map((entry) => toolExpression(entry.path))
        .join(", ")}.`,
    )
  }
  const delta = parts.join("\n\n")
  if (delta.length < replacement.length) return delta
  return replacement
}

function diffByKey<A>(
  previous: ReadonlyArray<A>,
  current: ReadonlyArray<A>,
  key: (value: A) => string,
  changed: (before: A, after: A) => boolean,
) {
  const currentKeys = new Set(current.map(key))
  const before = new Map(previous.map((value) => [key(value), value]))
  return {
    added: current.filter((value) => !before.has(key(value))),
    removed: previous.filter((value) => !currentKeys.has(key(value))),
    changed: current.flatMap((value) => {
      const old = before.get(key(value))
      return old === undefined || !changed(old, value) ? [] : [{ previous: old, current: value }]
    }),
  }
}
