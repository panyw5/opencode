import { createEffect, createMemo, on } from "solid-js"
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

    createEffect(() => {
      sdk.client
      sdk.directory
      const hit = cachedSkills(sdk)
      if (hit) {
        setState("list", hit)
        setState("loading", false)
        return
      }

      setState("loading", true)
      void loadSkills(sdk)
        .then((list) => {
          setState("list", list)
        })
        .catch(() => undefined)
        .finally(() => {
          setState("loading", false)
        })
    })

    // Math skills are filtered server-side from config.math.disabled, so the
    // cached list must be re-fetched whenever that flag flips.
    createEffect(
      on(
        () => globalSync.data.config.math?.disabled === true,
        () => {
          console.debug(`[skills] math config changed, reloading list`)
          void loadSkills(sdk, { force: true })
            .then((list) => {
              setState("list", list)
            })
            .catch(() => undefined)
        },
        { defer: true },
      ),
    )

    return {
      list: createMemo(() => state.list),
      loading: createMemo(() => state.loading),
      reload: () => loadSkills(sdk, { force: true }).then((list) => setState("list", list)),
    }
  },
})
