type SessionProfile = {
  id: number
  started: number
  last: number
}

const profiles = new Map<string, SessionProfile>()
let sequence = 0

function log(sessionID: string, stage: string, profile: SessionProfile, detail?: string) {
  const now = performance.now()
  const total = Math.round((now - profile.started) * 10) / 10
  const delta = Math.round((now - profile.last) * 10) / 10
  profile.last = now
  console.debug(
    `[session-profile] id=${String(profile.id)} sid=${sessionID} stage=${stage} total_ms=${String(total)} delta_ms=${String(delta)}${detail ? ` ${detail}` : ""}`,
  )
}

export function startSessionProfile(sessionID: string, source: string) {
  if (!import.meta.env.DEV) return
  const profile = { id: ++sequence, started: performance.now(), last: performance.now() }
  profiles.set(sessionID, profile)
  log(sessionID, "start", profile, `source=${source}`)
  window.setTimeout(() => {
    if (profiles.get(sessionID)?.id === profile.id) profiles.delete(sessionID)
  }, 10_000)
}

export function ensureSessionProfile(sessionID: string, source: string) {
  if (!import.meta.env.DEV || profiles.has(sessionID)) return
  startSessionProfile(sessionID, source)
}

export function markSessionProfile(sessionID: string, stage: string, detail?: string) {
  if (!import.meta.env.DEV) return
  const profile = profiles.get(sessionID)
  if (!profile) return
  log(sessionID, stage, profile, detail)
}
