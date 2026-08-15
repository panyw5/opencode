export type OrderedMessage = {
  id: string
  time?: {
    created?: number
  }
}

export function compareMessages(a: OrderedMessage, b: OrderedMessage) {
  const createdA = a.time?.created
  const createdB = b.time?.created
  if (typeof createdA === "number" && typeof createdB === "number" && createdA !== createdB) {
    return createdA < createdB ? -1 : 1
  }
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

export function sortMessages<T extends OrderedMessage>(list: readonly T[]) {
  if (list.length < 2) return list as T[]
  let timed = 0
  for (const item of list) {
    if (typeof item.time?.created !== "number") continue
    timed += 1
    if (timed < 2) continue
    return list.slice().sort(compareMessages)
  }
  return list as T[]
}

export function resolveMessage<T extends OrderedMessage>(list: readonly T[], id: string) {
  return list.find((item) => item.id === id)
}

export function compareMessageToId<T extends OrderedMessage>(list: readonly T[], message: T, id: string) {
  return compareMessages(message, resolveMessage(list, id) ?? { id })
}
