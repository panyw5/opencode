import { Button } from "@opencode-ai/ui/button"
import { createEffect, createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { DirectoryInput } from "@/components/directory-input"
import { displayToAbsolute } from "@/components/dialog-select-directory"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

export function HomePathInput(props: { home: string; onOpen: (directory: string) => void; onBrowse: () => void }) {
  const platform = usePlatform()
  const language = useLanguage()
  const [state, setState] = createStore({ query: "~/", selecting: false, error: "" })
  const targetPath = createMemo(() => displayToAbsolute(state.query, props.home, props.home))
  createEffect(() => {
    state.query
    setState("error", "")
  })

  async function submit(path = targetPath()) {
    if (!path || state.selecting) return
    setState({ selecting: true, error: "" })
    try {
      if (platform.filterDirectories) {
        const [valid] = await platform.filterDirectories([path])
        if (!valid) {
          setState("error", language.t("home.quickAdd.invalid"))
          return
        }
        props.onOpen(valid)
        return
      }
      props.onOpen(path)
    } catch (error) {
      setState("error", error instanceof Error ? error.message : language.t("home.quickAdd.invalid"))
    } finally {
      setState("selecting", false)
    }
  }

  return (
    <div data-component="home-path-input" class="home-path-launcher relative">
      <div class="home-path-controls flex flex-col gap-2 sm:flex-row">
        <DirectoryInput
          label={language.t("home.quickAdd.label")}
          hideLabel
          home={props.home}
          value={state.query}
          placeholder={language.t("home.quickAdd.placeholder")}
          onChange={(query) => setState("query", query)}
          onSubmit={(path) => void submit(path)}
          onBrowse={props.onBrowse}
        />
        <Button
          size="large"
          variant="primary"
          class="home-path-open !h-11 min-w-24 shrink-0 justify-center"
          disabled={state.selecting || !targetPath()}
          onClick={() => void submit()}
        >
          {state.selecting ? language.t("common.loading") : language.t("home.quickAdd.add")}
        </Button>
      </div>
      <Show when={state.error}>
        <div role="alert" class="mt-2 text-12-regular text-text-danger">
          {state.error}
        </div>
      </Show>
    </div>
  )
}
