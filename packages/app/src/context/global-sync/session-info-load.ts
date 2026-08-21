import { retry } from "@opencode-ai/core/util/retry"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { domainFromDirectory, type DomainId } from "@/pages/layout/extra-agents"
import { workspaceKey } from "@/pages/layout/helpers"

const inflight = new Map<string, Promise<Session | undefined>>()
const generation = new Map<DomainId, number>()
const directoryGeneration = new Map<string, number>()
const sessionGeneration = new Map<string, number>()

const keyFor = (domain: DomainId, directory: string, sessionID: string) =>
  `${domain}\n${workspaceKey(directory)}\n${sessionID}`
const directoryKey = (domain: DomainId, directory: string) => `${domain}\n${workspaceKey(directory)}\n`

export function resolveSessionInfoCommit(current: Session | undefined, incoming: Session) {
  if (current && current.time.updated > incoming.time.updated) return current
  return incoming
}

export function clearSessionInfoLoads(domain: DomainId) {
  generation.set(domain, (generation.get(domain) ?? 0) + 1)
  const prefix = `${domain}\n`
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key)
  }
  for (const key of directoryGeneration.keys()) {
    if (key.startsWith(prefix)) directoryGeneration.delete(key)
  }
  for (const key of sessionGeneration.keys()) {
    if (key.startsWith(prefix)) sessionGeneration.delete(key)
  }
}

export function clearSessionInfoDirectory(directory: string) {
  const domain = domainFromDirectory(directory)
  const prefix = directoryKey(domain, directory)
  directoryGeneration.set(prefix, (directoryGeneration.get(prefix) ?? 0) + 1)
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key)
  }
  for (const key of sessionGeneration.keys()) {
    if (key.startsWith(prefix)) sessionGeneration.delete(key)
  }
}

export function clearSessionInfos(directory: string, sessionIDs: Iterable<string>) {
  const domain = domainFromDirectory(directory)
  for (const sessionID of sessionIDs) {
    const key = keyFor(domain, directory, sessionID)
    const pending = inflight.get(key)
    sessionGeneration.set(key, (sessionGeneration.get(key) ?? 0) + 1)
    inflight.delete(key)
    if (!pending) sessionGeneration.delete(key)
  }
}

export function loadSessionInfo(input: {
  directory: string
  sessionID: string
  load: () => Promise<Session | undefined>
}) {
  const domain = domainFromDirectory(input.directory)
  const key = keyFor(domain, input.directory, input.sessionID)
  const pending = inflight.get(key)
  if (pending) {
    console.debug(`[session-info] join directory=${input.directory} sid=${input.sessionID}`)
    return pending
  }

  console.debug(`[session-info] load directory=${input.directory} sid=${input.sessionID}`)
  const currentGeneration = generation.get(domain) ?? 0
  const prefix = directoryKey(domain, input.directory)
  const currentDirectoryGeneration = directoryGeneration.get(prefix) ?? 0
  const currentSessionGeneration = sessionGeneration.get(key) ?? 0
  const promise = retry(input.load)
    .then((value) =>
      (generation.get(domain) ?? 0) === currentGeneration &&
      (directoryGeneration.get(prefix) ?? 0) === currentDirectoryGeneration &&
      (sessionGeneration.get(key) ?? 0) === currentSessionGeneration
        ? value
        : undefined,
    )
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key)
      if (!inflight.has(key)) sessionGeneration.delete(key)
      if (![...inflight.keys()].some((item) => item.startsWith(prefix))) directoryGeneration.delete(prefix)
    })
  inflight.set(key, promise)
  return promise
}
