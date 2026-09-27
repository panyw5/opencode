import type { ToolPart } from "@opencode-ai/sdk/v2"

/**
 * Height estimators for tool parts whose renderers are registered at runtime
 * (e.g. by extensions). The virtualized timeline consults these before the
 * generic collapsed/open defaults; measured heights still win once rendered.
 */

export type ToolHeightEstimator = (input: {
  part: ToolPart
  width: number
  viewportWidth?: number
  open: boolean
}) => number | undefined

const estimators = new Map<string, ToolHeightEstimator>()

// Returns a disposer that restores the previous estimator, but only while this
// registration is still the active one for the tool name.
export function registerToolHeightEstimator(tool: string, estimator: ToolHeightEstimator) {
  const previous = estimators.get(tool)
  estimators.set(tool, estimator)
  return () => {
    if (estimators.get(tool) !== estimator) return
    if (previous) estimators.set(tool, previous)
    else estimators.delete(tool)
  }
}

/** Registered estimate for a tool part, or undefined to fall back to defaults. */
export function estimateRegisteredToolHeight(input: {
  part: ToolPart
  width: number
  viewportWidth?: number
  open: boolean
}) {
  const estimator = estimators.get(input.part.tool)
  if (!estimator) return
  try {
    const value = estimator(input)
    if (value === undefined || !Number.isFinite(value) || value < 0) return
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[timeline] tool height estimator failed tool=${input.part.tool} error=${message}`)
  }
}
