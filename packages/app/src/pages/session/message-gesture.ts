export const normalizeWheelDelta = (input: { deltaY: number; deltaMode: number; rootHeight: number }) => {
  if (input.deltaMode === 1) return input.deltaY * 40
  if (input.deltaMode === 2) return input.deltaY * input.rootHeight
  return input.deltaY
}

export const shouldSmoothDiscreteWheel = (input: {
  deltaX: number
  deltaY: number
  deltaMode: number
  wheelDeltaY?: number
  macOS: boolean
}) => {
  if (!input.macOS) return false
  if (!input.deltaY || Math.abs(input.deltaX) > Math.abs(input.deltaY)) return false
  if (input.deltaMode !== 0) return true

  // Chromium exposes traditional wheel notches as multiples of 120 through
  // the legacy field even when deltaMode has already been converted to pixels.
  // Trackpad deltas are high-frequency and almost never land on this cadence.
  const legacy = Math.abs(input.wheelDeltaY ?? 0)
  if (legacy >= 120 && Math.abs(legacy % 120) < 0.01) return true

  // Fallback for mice/drivers that omit wheelDeltaY but emit coarse pixel steps.
  return Math.abs(input.deltaY) >= 80 && Number.isInteger(input.deltaY)
}

export const accumulateSmoothWheelTarget = (input: {
  current: number
  target?: number
  delta: number
  max: number
}) => Math.max(0, Math.min(input.max, (input.target ?? input.current) + input.delta))

export const smoothWheelFramePosition = (input: {
  current: number
  target: number
  elapsed: number
  timeConstant?: number
}) => {
  const elapsed = Math.max(0, Math.min(input.elapsed, 32))
  const factor = 1 - Math.exp(-elapsed / (input.timeConstant ?? 70))
  return input.current + (input.target - input.current) * factor
}

export const shouldMarkBoundaryGesture = (input: {
  delta: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}) => {
  const max = input.scrollHeight - input.clientHeight
  if (max <= 1) return true
  if (!input.delta) return false

  if (input.delta < 0) return input.scrollTop + input.delta <= 0

  const remaining = max - input.scrollTop
  return input.delta > remaining
}
