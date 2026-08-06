import { createStore, produce } from "solid-js/store"

/** Pending project-task selection for the new-session screen (no session id yet). */
export type PendingProjectTaskMount = {
  taskID: string | undefined
  inject: boolean
}

const [store, setStore] = createStore({
  byDirectory: {} as Record<string, PendingProjectTaskMount>,
})

const key = (directory: string) => directory || "default"

export function pendingProjectTaskMount(directory: string): PendingProjectTaskMount {
  return store.byDirectory[key(directory)] ?? { taskID: undefined, inject: true }
}

export function setPendingProjectTaskMount(
  directory: string,
  next: Partial<PendingProjectTaskMount> | null,
) {
  const id = key(directory)
  if (next === null) {
    setStore(
      "byDirectory",
      produce((draft) => {
        delete draft[id]
      }),
    )
    return
  }
  const prev = store.byDirectory[id] ?? { taskID: undefined, inject: true }
  setStore("byDirectory", id, { ...prev, ...next })
}

/** Read + clear pending mount for a directory (used right after session.create). */
export function takePendingProjectTaskMount(directory: string): PendingProjectTaskMount | undefined {
  const id = key(directory)
  const value = store.byDirectory[id]
  if (!value?.taskID) {
    if (value) setPendingProjectTaskMount(directory, null)
    return undefined
  }
  setPendingProjectTaskMount(directory, null)
  return value
}
