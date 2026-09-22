export type BellToastType = "turn-complete" | "error"

export type BellToast = {
  id: string
  type: BellToastType
  session?: string
  directory?: string
  title?: string
  time: number
}

export const BELL_TOAST_TTL_MS = 5000
export const MAX_BELL_TOASTS = 4

export function bellToastID(type: BellToastType, session?: string) {
  return `${type}:${session ?? "global"}`
}

export function pushBellToast(list: BellToast[], item: BellToast, max = MAX_BELL_TOASTS): BellToast[] {
  // Newest at the head. A repeat for the same session + type replaces the
  // older entry instead of stacking duplicates.
  const filtered = list.filter((toast) => toast.id !== item.id)
  return [item, ...filtered].slice(0, max)
}

export function expireBellToasts(list: BellToast[], now: number, ttl = BELL_TOAST_TTL_MS): BellToast[] {
  return list.filter((toast) => now - toast.time < ttl)
}

export function removeBellToast(list: BellToast[], id: string): BellToast[] {
  return list.filter((toast) => toast.id !== id)
}
