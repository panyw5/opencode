import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { usePlatform } from "@/context/platform"

type FetchedModel = { id: string; name: string }

function normalizeFetchedModel(raw: unknown): FetchedModel | undefined {
  if (typeof raw === "string") {
    const id = raw.trim()
    return id ? { id, name: id } : undefined
  }
  if (!raw || typeof raw !== "object") return undefined
  const rec = raw as Record<string, unknown>
  const id = String(rec.id ?? rec.name ?? "").trim()
  if (!id) return undefined
  const name = String(rec.name ?? rec.display_name ?? rec.id ?? id).trim() || id
  return { id, name }
}

type Props = {
  baseURL: string
  apiKey: string
  headers: Array<{ key: string; value: string }>
  existingModelIDs: Set<string>
  onAdd: (id: string, name: string) => void
  /** Optional heading shown on the same row, left of the fetch button */
  title?: string
}

export function FetchProviderModels(props: Props) {
  const platform = usePlatform()
  const [fetching, setFetching] = createSignal(false)
  const [models, setModels] = createSignal<FetchedModel[]>([])
  const [error, setError] = createSignal<string>()
  const [searchQuery, setSearchQuery] = createSignal("")

  // Reset state when provider (baseURL) changes
  createEffect(() => {
    props.baseURL
    setModels([])
    setError(undefined)
    setSearchQuery("")
  })

  // Filter models based on search query
  const filteredModels = createMemo(() => {
    const query = searchQuery().toLowerCase().trim()
    if (!query) return models()
    return models().filter((model) => {
      const haystack = `${model.id} ${model.name}`.toLowerCase()
      return haystack.includes(query)
    })
  })

  const canFetch = () => !!props.baseURL.trim() && !!props.apiKey.trim()

  const fetchModels = async () => {
    if (!canFetch() || fetching()) return
    setFetching(true)
    setError(undefined)
    setModels([])

    try {
      const base = props.baseURL.trim().replace(/\/+$/, "")
      const reqHeaders: Record<string, string> = {
        Authorization: `Bearer ${props.apiKey.trim()}`,
      }
      for (const h of props.headers) {
        if (h.key.trim() && h.value.trim()) reqHeaders[h.key.trim()] = h.value.trim()
      }

      // Use fetchExternal to bypass Tauri's loopback routing restriction,
      // allowing requests to local AI servers (e.g. 127.0.0.1:8084) that
      // don't set CORS headers.
      const doFetch = platform.fetchExternal ?? fetch
      const res = await doFetch(`${base}/models`, { headers: reqHeaders })
      if (!res.ok) {
        setError(`HTTP ${res.status}: ${res.statusText}`)
        return
      }

      const json = await res.json()
      let list: FetchedModel[] = []
      if (Array.isArray(json)) {
        list = json.map(normalizeFetchedModel).filter((m): m is FetchedModel => !!m)
      } else if (Array.isArray(json?.data)) {
        const data = json?.data as unknown[]
        list = data.map(normalizeFetchedModel).filter((m): m is FetchedModel => !!m)
      } else if (Array.isArray(json?.models)) {
        const models = json?.models as unknown[]
        list = models.map(normalizeFetchedModel).filter((m): m is FetchedModel => !!m)
      }
      setModels(list)
      if (list.length === 0) setError("未找到模型")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFetching(false)
    }
  }

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2 flex-wrap">
        <Show when={props.title}>
          <div class="text-14-medium text-text-strong">{props.title}</div>
        </Show>
        <Button
          type="button"
          size="large"
          variant="primary"
          icon={fetching() ? undefined : "arrow-sync"}
          onClick={() => void fetchModels()}
          disabled={!canFetch() || fetching()}
        >
          <Show when={fetching()}>
            <Spinner class="size-3.5" />
          </Show>
          {fetching() ? "获取中..." : "获取模型"}
        </Button>
        <Show when={error()}>
          <span class="text-12-regular text-text-danger-base">{error()}</span>
        </Show>
      </div>
      <Show when={models().length > 0}>
        <div class="flex flex-col gap-2">
          <TextField
            placeholder="搜索模型..."
            value={searchQuery()}
            onChange={setSearchQuery}
            icon="search"
          />
          <div
            class="flex flex-wrap gap-1.5 rounded-lg border border-border-base p-2"
            style="background: var(--yuzu-dark-alpha-3);"
          >
            <For each={filteredModels()}>
              {(model) => {
                const added = () => props.existingModelIDs.has(model.id)
                return (
                  <button
                    type="button"
                    title={model.name !== model.id ? `${model.name} · ${model.id}` : model.id}
                    disabled={added()}
                    class="inline-flex h-7 max-w-full items-center gap-1 rounded-full border px-2.5 text-12-medium transition-colors"
                    classList={{
                      "cursor-default border-border-weak-base bg-surface-secondary text-text-weak opacity-50": added(),
                      "cursor-pointer border-border-base bg-background-base text-text-base hover:border-border-strong hover:bg-surface-base-hover":
                        !added(),
                    }}
                    onClick={() => !added() && props.onAdd(model.id, model.name)}
                  >
                    <span class="truncate">{model.name}</span>
                    <Show when={!added()}>
                      <span class="text-text-weak">+</span>
                    </Show>
                    <Show when={added()}>
                      <span class="text-text-weak">✓</span>
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
