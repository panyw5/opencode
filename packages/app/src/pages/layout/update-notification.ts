import { onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { Platform, UpdaterState } from "@/context/platform"

export function createUpdateNotification(platform: Pick<Platform, "getUpdaterState" | "onUpdaterStateChanged">) {
  const [store, setStore] = createStore({ available: false })

  onMount(() => {
    if (!platform.getUpdaterState || !platform.onUpdaterStateChanged) return
    let received = false
    let disposed = false
    let status: UpdaterState["status"] | undefined
    const apply = (state: UpdaterState) => {
      if (disposed) return
      if (
        state.status === "downloading" ||
        state.status === "paused" ||
        state.status === "ready" ||
        state.status === "installing"
      ) {
        setStore("available", true)
      }
      if (state.status === "disabled" || state.status === "idle" || state.status === "up-to-date") {
        setStore("available", false)
      }
      // Checking or a failed transfer does not invalidate an already known update.
      if (status === state.status) return
      status = state.status
      console.debug(`[update-notification] state status=${status} available=${store.available}`)
    }
    console.debug("[update-notification] subscribing and reading initial state")
    const unsubscribe = platform.onUpdaterStateChanged((state) => {
      received = true
      apply(state)
    })
    void platform
      .getUpdaterState()
      .then((state) => {
        if (!received) apply(state)
      })
      .catch((error) => {
        console.error(`[update-notification] state read failed message=${String(error)}`)
      })
    onCleanup(() => {
      disposed = true
      unsubscribe()
      console.debug("[update-notification] unsubscribed")
    })
  })

  return () => store.available
}
