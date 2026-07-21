import { Cron } from "croner"
import { Schedule, InvalidScheduleError } from "./schema"

const MAX_TIMEOUT = 2_147_483_647

export function validate(schedule: Schedule): void {
  if (schedule.kind === "at") return
  if (schedule.kind === "every") {
    if (!Number.isSafeInteger(schedule.interval) || schedule.interval <= 0) {
      throw new InvalidScheduleError({ message: "Interval must be a positive integer" })
    }
    return
  }

  const expression = normalizeExpression(schedule.expression)
  if (!expression) throw new InvalidScheduleError({ message: "Cron expression is required" })
  try {
    const cron = new Cron(expression, { paused: true, timezone: schedule.timezone })
    cron.nextRun(new Date())
    cron.stop()
  } catch (error) {
    throw new InvalidScheduleError({ message: error instanceof Error ? error.message : String(error) })
  }
}

export function next(schedule: Schedule, now: number): number | undefined {
  validate(schedule)
  if (schedule.kind === "at") return schedule.at
  if (schedule.kind === "every") return now + schedule.interval

  const cron = new Cron(normalizeExpression(schedule.expression), {
    paused: true,
    timezone: schedule.timezone,
  })
  try {
    return cron.nextRun(new Date(now))?.getTime()
  } finally {
    cron.stop()
  }
}

export function nextAfterOccurrence(schedule: Schedule, scheduledAt: number, now: number): number | undefined {
  validate(schedule)
  if (schedule.kind === "at") return undefined
  if (schedule.kind === "every") {
    const elapsed = Math.max(0, now - scheduledAt)
    return scheduledAt + (Math.floor(elapsed / schedule.interval) + 1) * schedule.interval
  }
  return next(schedule, Math.max(now, scheduledAt))
}

export function delay(target: number, now = Date.now()): number {
  return Math.min(Math.max(0, target - now), MAX_TIMEOUT)
}

function normalizeExpression(expression: string): string {
  const value = expression.trim()
  const count = value.split(/\s+/).filter(Boolean).length
  if (count === 5) return `0 ${value}`
  return value
}

export * as ScheduledTaskSchedule from "./schedule"
