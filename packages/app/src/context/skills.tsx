import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSync } from "@/context/global-sync"
import { useSDK } from "@/context/sdk"
import { cachedSkills, loadSkills, type SkillInfo } from "@/utils/skills"

export const { use: useSkills, provider: SkillsProvider } = createSimpleContext({
  name: "Skills",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const globalSync = useGlobalSync()
    const [state, setState] = createStore({
      list: cachedSkills(sdk) ?? ([] as SkillInfo[]),
      loading: false,
    })

    let run = 0
    onCleanup(() => {
      run++
    })
    const refresh = (force = false) => {
      const token = ++run
      const client = sdk.client
      const directory = sdk.directory
      const version = globalSync.version
      const current = () =>
        token === run && sdk.client === client && sdk.directory === directory && globalSync.version === version
      setState("loading", true)
      return loadSkills(sdk, { force })
        .then((list) => {
          if (current()) setState("list", list)
        })
        .catch(() => undefined)
        .finally(() => {
          if (current()) setState("loading", false)
        })
    }
    createEffect(() => {
      sdk.client
      sdk.directory
      void refresh()
    })

    // Math skills are filtered server-side from config.math.disabled, so the
    // cached list must be re-fetched whenever that flag flips.
    createEffect(
      on(
        () => globalSync.data.config.math?.disabled === true,
        () => {
          console.debug(`[skills] math config changed, reloading list`)
          void refresh(true)
        },
        { defer: true },
      ),
    )

    return {
      list: createMemo(() => state.list),
      loading: createMemo(() => state.loading),
      reload: () => refresh(true),
    }
  },
})
