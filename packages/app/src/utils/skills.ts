import { useSDK } from "@/context/sdk"
import { createFreshRequestQueue } from "./fresh-request-queue"

export type SkillInfo = {
  name: string
  description?: string
  location: string
  content: string
}

const cache = new Map<string, SkillInfo[]>()
const wait = new Map<string, Promise<SkillInfo[]>>()
const refreshes = createFreshRequestQueue<SkillInfo[]>()
const revisions = new Map<string, number>()
const client = new WeakMap<object, number>()
let next = 0

function cid(value: object) {
  const hit = client.get(value)
  if (hit !== undefined) return hit
  const id = ++next
  client.set(value, id)
  return id
}

function key(sdk: ReturnType<typeof useSDK>) {
  return `${sdk.directory}\n${cid(sdk.client)}`
}

export function cachedSkills(sdk: ReturnType<typeof useSDK>) {
  return cache.get(key(sdk))
}

export async function loadSkills(sdk: ReturnType<typeof useSDK>, options?: { force?: boolean }): Promise<SkillInfo[]> {
  const id = key(sdk)
  const hit = cache.get(id)
  if (hit && !options?.force) return hit

  if (options?.force) cache.delete(id)

  const task = wait.get(id)
  if (task) {
    if (!options?.force) return task
    revisions.set(id, (revisions.get(id) ?? 0) + 1)
    return refreshes.enqueue(
      id,
      task,
      () => (key(sdk) === id ? loadSkills(sdk, { force: true }) : Promise.resolve([])),
      () => [],
    )
  }
  const revision = revisions.get(id) ?? 0
  console.debug(`[skills-cache] load-start key=${id}`)

  const job = sdk.client.app
    .skills({}, { throwOnError: true })
    .then((resp) => {
      if (wait.get(id) !== job || (revisions.get(id) ?? 0) !== revision || key(sdk) !== id) {
        console.debug(`[skills-cache] discard key=${id}`)
        return cache.get(id) ?? []
      }
      const list = resp.data ?? []
      cache.set(id, list)
      console.debug(`[skills-cache] commit key=${id} count=${list.length}`)
      return list
    })
    .catch((err) => {
      if (wait.get(id) !== job || (revisions.get(id) ?? 0) !== revision || key(sdk) !== id) return cache.get(id) ?? []
      throw err
    })
    .finally(() => {
      if (wait.get(id) !== job) return
      wait.delete(id)
      revisions.delete(id)
    })

  wait.set(id, job)
  return job
}
