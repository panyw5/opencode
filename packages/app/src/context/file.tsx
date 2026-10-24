import { batch, createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { getFilename } from "@opencode-ai/core/util/path"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { createPathHelpers } from "./file/path"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"
import { createFileViewCache } from "./file/view-cache"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { workspacePathContext } from "@/pages/layout/helpers"
import { useWorkspaceTree } from "./file/workspace-tree"
import { createFileContentLoader } from "./file/content-loader"
import { createWatcherInvalidator } from "./file/watcher"
import { createFileRevalidation } from "./file/revalidation"
import { watchVisibleFile } from "./file/visible-watch"
import { useGlobalSDK } from "./global-sdk"
import { domainFromDirectory } from "@/pages/layout/extra-agents"
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "./file/types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

export const { use: useFile, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const globalSDK = useGlobalSDK()
    useSync()
    const params = useParams()
    const server = useServer()
    const platform = usePlatform()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk.directory)
    const path = createPathHelpers(scope)
    const tabs = layout.tabs(() => `${params.dir}${params.id ? "/" + params.id : ""}`)

    const [store, setStore] = createStore<{
      file: Record<string, FileState>
      visible: Record<string, number>
      foreground: boolean
    }>({
      file: {},
      visible: {},
      foreground: typeof document === "undefined" || document.visibilityState !== "hidden",
    })

    const tree = useWorkspaceTree()

    const evictContent = (keep?: Set<string>) => {
      evictContentLru(keep, (target) => {
        if (!store.file[target]) return
        setStore(
          "file",
          target,
          produce((draft) => {
            draft.content = undefined
            draft.loaded = false
          }),
        )
      })
    }

    const viewCache = createFileViewCache(
      workspacePathContext({ os: platform.os, isLocal: !!server.isLocal(), directory: scope() }),
    )
    const view = createMemo(() => viewCache.load(scope(), params.id))

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore("file", file, { path: file, name: getFilename(file) })
    }

    const setLoading = (file: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = true
          draft.error = undefined
        }),
      )
    }

    const setLoaded = (file: string, content: FileState["content"]) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loaded = true
          draft.loading = false
          draft.content = content
        }),
      )
    }

    const setLoadError = (file: string, message: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.error = message
          draft.loaded = false
          draft.content = undefined
        }),
      )
      removeFileContentBytes(file)
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: message,
      })
    }

    const loader = createFileContentLoader({
      scope,
      normalize: path.normalize,
      loaded: (file) => store.file[file]?.loaded === true,
      read: (file) => sdk.client.file.read({ path: file }),
      onLoading: (file) => {
        ensure(file)
        setLoading(file)
      },
      onContent: (file, content) => {
        setLoaded(file, content)
        if (!content) {
          removeFileContentBytes(file)
          return
        }
        touchFileContent(file, approxBytes(content))
        evictContent(new Set([file]))
      },
      onError: (file, error) => setLoadError(file, errorMessage(error, language.t("error.chain.unknown"))),
    })
    const load = loader.load
    const visible = () => (store.foreground ? Object.keys(store.visible).filter((file) => store.visible[file] > 0) : [])
    const revalidation = createFileRevalidation({
      visible,
      stale: loader.invalidate,
      load: (file) => load(file, { force: true }),
    })
    createEffect(() => {
      scope()
      sdk.client
      loader.reset()
      revalidation.reset()
      invalidator.dispose()
      resetFileContentLru()
      batch(() => {
        setStore("file", reconcile({}))
      })
    })

    const search = (query: string, dirs: "true" | "false") =>
      sdk.client.find.files({ query, dirs }).then(
        (x) => (x.data ?? []).map(path.normalize),
        () => [],
      )

    const invalidator = createWatcherInvalidator({
      normalize: path.normalize,
      hasFile: (file) => Boolean(store.file[file]),
      isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
      loadFile: (file) => {
        revalidation.invalidate(file, "watcher")
      },
      files: () => [...new Set([...Object.keys(store.file), ...visible()])],
      node: () => undefined,
      isDirLoaded: () => false,
      refreshDir: () => {},
    })

    const stop = sdk.event.listen((e) => {
      invalidator.handle(e.details)
    })
    const stopReconnect = globalSDK.listenAll((e) => {
      if (e.domain !== domainFromDirectory(scope())) return
      if (e.name !== "global" || e.details.type !== "server.connected") return
      revalidation.visible("reconnect")
    })

    const streams = new Set<ReturnType<typeof watchVisibleFile>>()
    createEffect(() => {
      const paths = visible()
      sdk.client
      if (!paths.length) return
      // Match the global event stream's native-fetch policy; desktop buffered
      // IPC fetches must not be used for a local streaming response.
      const url = new URL(sdk.url)
      const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
      const client = sdk.client
      const streamFetch =
        url.protocol === "http:" && !loopback && platform.fetch ? platform.fetch : globalThis.fetch.bind(globalThis)
      for (const target of paths) {
        console.debug(`[file-preview] watch start path=${target}`)
        const stream = watchVisibleFile({
          subscribe: (signal) =>
            client.file.watch({ path: target }, { fetch: streamFetch, signal, sseMaxRetryAttempts: 1 }),
          change: (event) => invalidator.handle({ type: event.type, properties: event.properties }),
        })
        streams.add(stream)
        onCleanup(() => {
          stream.dispose()
          streams.delete(stream)
          console.debug(`[file-preview] watch stop path=${target}`)
        })
      }
    })

    const foreground = (event: Event) => {
      const active = document.visibilityState !== "hidden"
      setStore("foreground", active)
      if (!active) return
      revalidation.visible(event.type === "online" ? "online" : "foreground")
      for (const stream of streams) stream.reconnect()
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", foreground)
      window.addEventListener("online", foreground)
      document.addEventListener("visibilitychange", foreground)
    }

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(file)) {
        touchFileContent(file)
        return state
      }
      touchFileContent(file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))
    const requestSelection = (input: string, range: SelectedLineRange) =>
      withPath(input, (file) => view().requestSelection(file, range))
    const selectionSeq = (input: string): number => withPath(input, (file) => view().selectionSeq(file)) as number
    const selectionPending = (input: string): boolean =>
      withPath(input, (file) => view().selectionPending(file)) as boolean
    const settleSelection = (input: string, seq: number) => withPath(input, (file) => view().settleSelection(file, seq))

    onCleanup(() => {
      stop()
      stopReconnect()
      revalidation.reset()
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", foreground)
        window.removeEventListener("online", foreground)
        document.removeEventListener("visibilitychange", foreground)
      }
      loader.reset()
      invalidator.dispose()
      viewCache.clear()
    })

    return {
      ready: () => view().ready(),
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: (input: string, opts?: { force?: boolean }) => untrack(() => tree.listDir(input, opts)),
        refresh: (input: string) => untrack(() => tree.listDir(input, { force: true })),
        state: tree.dirState,
        children: tree.children,
        demanded: tree.demanded,
        acquireDemand: (kind?: "tree" | "picker") => tree.acquireDemand(kind),
        expand: (input: string) => untrack(() => tree.expandDir(input)),
        collapse: (input: string) => untrack(() => tree.collapseDir(input)),
        toggle(input: string) {
          if (tree.dirState(input)?.expanded) {
            untrack(() => tree.collapseDir(input))
            return
          }
          untrack(() => tree.expandDir(input))
        },
      },
      get,
      load,
      refresh: (input: string) => revalidation.refresh(path.normalize(input)),
      watch(input: string) {
        const file = path.normalize(input)
        setStore("visible", file, (count = 0) => count + 1)
        return () => setStore("visible", file, (count = 0) => Math.max(0, count - 1))
      },
      scrollTop,
      scrollLeft,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      requestSelection,
      selectionSeq,
      selectionPending,
      settleSelection,
      searchFiles: (query: string) => search(query, "false"),
      searchFilesAndDirectories: (query: string) => search(query, "true"),
    }
  },
})
