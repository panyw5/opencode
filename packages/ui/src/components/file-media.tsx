import type { FileContent } from "@opencode-ai/sdk/v2"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
  type JSX,
} from "solid-js"
import { useI18n } from "../context/i18n"
import {
  dataUrlFromMediaValue,
  hasMediaValue,
  isBinaryContent,
  fileExtension,
  mediaKindFromPath,
  normalizeMimeType,
  svgTextFromValue,
} from "../pierre/media"
import { parseDelimitedText } from "./file-preview-model"
import { IconButton } from "./icon-button"
import { Tooltip } from "./tooltip"

export type FileMediaOptions = {
  mode?: "auto" | "off"
  path?: string
  current?: unknown
  before?: unknown
  after?: unknown
  readFile?: (path: string) => Promise<FileContent | undefined>
  onLoad?: () => void
  onError?: (ctx: { kind: "image" | "audio" | "svg" | "pdf" }) => void
}

function mediaValue(cfg: FileMediaOptions, mode: "image" | "audio" | "pdf") {
  if (cfg.current !== undefined) return cfg.current
  if (mode === "image") return cfg.after ?? cfg.before
  return cfg.after ?? cfg.before
}

export function FileMedia(props: {
  media?: FileMediaOptions
  fallback: () => JSX.Element
  openFolder?: () => void
  openWith?: JSX.Element
  copyPath?: () => void
  copyContent?: () => void
  copyPathCopied?: boolean
  copyContentCopied?: boolean
}) {
  const i18n = useI18n()
  const cfg = () => props.media
  const kind = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return
    return mediaKindFromPath(media.path)
  })
  const extension = createMemo(() => fileExtension(cfg()?.path))
  const textSource = createMemo(() => {
    const value = cfg()?.current
    if (typeof value === "string") return value
    if (!value || typeof value !== "object") return
    const record = value as { type?: unknown; content?: unknown }
    if (record.type === "text" && typeof record.content === "string") return record.content
  })
  const previewKind = createMemo(() => {
    if (!cfg() || cfg()?.mode === "off" || textSource() === undefined) return
    if (extension() === "csv" || extension() === "tsv") return "table" as const
  })
  const [sourceMode, setSourceMode] = createSignal(false)
  const table = createMemo(() => {
    const source = textSource()
    if (previewKind() !== "table" || source === undefined) return
    return parseDelimitedText(source, extension() === "tsv" ? "\t" : undefined)
  })
  const textPreviewHeader = () => (
    <div class="flex justify-end border-b border-border-weak-base px-3 py-2">
      <div class="inline-flex rounded-md border border-border-weak-base p-0.5">
        <button
          type="button"
          class="rounded px-2 py-1 text-12-medium"
          classList={{ "bg-background-stronger text-text-strong": !sourceMode(), "text-text-weak": sourceMode() }}
          aria-pressed={!sourceMode()}
          onClick={() => setSourceMode(false)}
        >
          {i18n.t("ui.file.preview")}
        </button>
        <button
          type="button"
          class="rounded px-2 py-1 text-12-medium"
          classList={{ "bg-background-stronger text-text-strong": sourceMode(), "text-text-weak": !sourceMode() }}
          aria-pressed={sourceMode()}
          onClick={() => setSourceMode(true)}
        >
          {i18n.t("ui.file.source")}
        </button>
      </div>
    </div>
  )

  const isBinary = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return false
    if (kind()) return false
    return isBinaryContent(media.current as any)
  })

  const onLoad = () => props.media?.onLoad?.()

  const deleted = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || !k) return false
    if (k === "svg") return false
    if (media.current !== undefined) return false
    return !hasMediaValue(media.after as any) && hasMediaValue(media.before as any)
  })

  const direct = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio" && k !== "pdf")) return
    return dataUrlFromMediaValue(mediaValue(media, k), k)
  })

  const request = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio" && k !== "pdf")) return
    if (media.current !== undefined) return
    if (deleted()) return
    if (direct()) return
    if (!media.path || !media.readFile) return

    return {
      key: `${k}:${media.path}`,
      kind: k,
      path: media.path,
      readFile: media.readFile,
      onError: media.onError,
    }
  })

  const [loaded] = createResource(request, async (input) => {
    return input.readFile(input.path).then(
      (result) => {
        const src = dataUrlFromMediaValue(result as any, input.kind)
        if (!src) {
          input.onError?.({ kind: input.kind })
          return { key: input.key, error: true as const }
        }

        return {
          key: input.key,
          src,
          mime: input.kind === "audio" || input.kind === "pdf" ? normalizeMimeType(result?.mimeType) : undefined,
        }
      },
      () => {
        input.onError?.({ kind: input.kind })
        return { key: input.key, error: true as const }
      },
    )
  })

  const remote = createMemo(() => {
    const input = request()
    const value = loaded()
    if (!input || !value || value.key !== input.key) return
    return value
  })

  const src = createMemo(() => {
    const value = remote()
    return direct() ?? (value && "src" in value ? value.src : undefined)
  })
  const status = createMemo(() => {
    if (direct()) return "ready" as const
    if (!request()) return "idle" as const
    if (loaded.loading) return "loading" as const
    if (remote()?.error) return "error" as const
    if (src()) return "ready" as const
    return "idle" as const
  })
  const audioMime = createMemo(() => {
    const value = remote()
    return value && "mime" in value ? value.mime : undefined
  })
  const pdfMime = createMemo(() => {
    const value = remote()
    return value && "mime" in value ? value.mime : undefined
  })

  const svgSource = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    return svgTextFromValue(media.current as any)
  })
  const svgSrc = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    return dataUrlFromMediaValue(media.current as any, "svg")
  })
  const svgInvalid = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    if (svgSource() !== undefined) return
    if (!hasMediaValue(media.current as any)) return
    return [media.path, media.current] as const
  })

  createEffect(
    on(
      svgInvalid,
      (value) => {
        if (!value) return
        cfg()?.onError?.({ kind: "svg" })
      },
      { defer: true },
    ),
  )

  const kindLabel = (value: "image" | "audio" | "pdf") =>
    i18n.t(
      value === "image"
        ? "ui.fileMedia.kind.image"
        : value === "audio"
          ? "ui.fileMedia.kind.audio"
          : "ui.fileMedia.kind.pdf",
    )
  const hasActions = () => Boolean(props.openWith || props.openFolder || props.copyPath || props.copyContent)
  const actions = () => (
    <Show when={hasActions()}>
      <div class="flex items-center justify-center gap-2">
        {props.openWith}
        <Show when={props.copyContent}>
          {(copyContent) => (
            <Tooltip value={i18n.t("ui.file.copyContent")} placement="bottom">
              <IconButton
                icon={props.copyContentCopied ? "check" : "copy-content"}
                variant="secondary"
                class="h-8 w-8 rounded-md"
                onClick={copyContent()}
                aria-label={i18n.t("ui.file.copyContent")}
              />
            </Tooltip>
          )}
        </Show>
        <Show when={props.openFolder}>
          {(openFolder) => (
            <Tooltip value={i18n.t("ui.file.openFolder")} placement="bottom">
              <IconButton
                icon="folder"
                variant="secondary"
                class="h-8 w-8 rounded-md"
                onClick={openFolder()}
                aria-label={i18n.t("ui.file.openFolder")}
              />
            </Tooltip>
          )}
        </Show>
        <Show when={props.copyPath}>
          {(copyPath) => (
            <Tooltip value={i18n.t("ui.file.copyPath")} placement="bottom">
              <IconButton
                icon={props.copyPathCopied ? "check" : "copy"}
                variant="secondary"
                class="h-8 w-8 rounded-md"
                onClick={copyPath()}
                aria-label={i18n.t("ui.file.copyPath")}
              />
            </Tooltip>
          )}
        </Show>
      </div>
    </Show>
  )
  const notice = (message: string, showActions = false) => (
    <div class="flex min-h-40 flex-col items-center justify-center gap-3 px-6 py-4 text-center text-text-weak">
      <div>{message}</div>
      <Show when={showActions}>{actions()}</Show>
    </div>
  )

  return (
    <Switch>
      <Match when={previewKind() && sourceMode()}>
        <div class="flex min-h-full flex-col">
          {textPreviewHeader()}
          {props.fallback()}
        </div>
      </Match>
      <Match when={previewKind() === "table" && !sourceMode()}>
        <div class="flex min-h-full flex-col bg-background-base">
          {textPreviewHeader()}
          <Show when={table()}>
            {(value) => (
              <div class="min-h-0 flex-1 overflow-auto p-4">
                <table class="w-full border-collapse text-left text-13-regular">
                  <Show
                    when={value().rows[0]}
                    fallback={
                      <tbody>
                        <tr>
                          <td class="px-3 py-2 text-text-weak">{i18n.t("ui.file.table.empty")}</td>
                        </tr>
                      </tbody>
                    }
                  >
                    <thead class="sticky top-0 bg-background-stronger text-text-strong">
                      <tr>
                        <For each={value().rows[0]}>
                          {(cell) => <th class="border border-border-weak-base px-3 py-2 font-medium">{cell}</th>}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={value().rows.slice(1)}>
                        {(row) => (
                          <tr class="even:bg-background-stronger/50">
                            <For each={row}>
                              {(cell) => (
                                <td class="max-w-96 whitespace-pre-wrap break-words border border-border-weak-base px-3 py-2 align-top">
                                  {cell}
                                </td>
                              )}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </Show>
                </table>
                <Show when={value().truncated}>
                  <div class="px-1 py-3 text-12-regular text-text-weak">{i18n.t("ui.file.table.limited")}</div>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Match>
      <Match when={kind() === "image" || kind() === "audio" || kind() === "pdf"}>
        <Show
          when={src()}
          fallback={(() => {
            const media = cfg()
            const k = kind()
            if (!media || (k !== "image" && k !== "audio" && k !== "pdf")) return props.fallback()
            const label = kindLabel(k)

            if (deleted()) {
              return notice(i18n.t("ui.fileMedia.state.removed", { kind: label }))
            }
            if (status() === "loading") {
              return notice(i18n.t("ui.fileMedia.state.loading", { kind: label }))
            }
            if (status() === "error") {
              return notice(i18n.t("ui.fileMedia.state.error", { kind: label }), true)
            }
            return notice(i18n.t("ui.fileMedia.state.unavailable", { kind: label }), true)
          })()}
        >
          {(value) => {
            const k = kind()
            if (k !== "image" && k !== "audio" && k !== "pdf") return props.fallback()
            if (k === "image") {
              return (
                <div class="flex flex-col bg-background-stronger">
                  <Show when={hasActions()}>
                    <div class="flex justify-end px-3 py-2">{actions()}</div>
                  </Show>
                  <div class="flex justify-center px-6 pb-4">
                    <img
                      src={value()}
                      alt={cfg()?.path}
                      class="max-h-[60vh] max-w-full rounded border border-border-weak-base bg-background-base object-contain"
                      onLoad={onLoad}
                    />
                  </div>
                </div>
              )
            }

            if (k === "pdf") {
              return (
                <div class="flex h-full min-h-full flex-col bg-background-stronger">
                  <Show when={hasActions()}>
                    <div class="flex justify-end px-3 py-2">{actions()}</div>
                  </Show>
                  {/* PDFs use the full panel height instead of the generic scroll shell used for text files. */}
                  <div class="min-h-0 flex-1 overflow-hidden bg-background-base">
                    <iframe
                      src={`${value()}#zoom=page-fit`}
                      title={cfg()?.path ?? i18n.t("ui.fileMedia.kind.pdf")}
                      class="size-full min-h-0 min-w-0"
                      onLoad={onLoad}
                    />
                  </div>
                  <Show when={pdfMime()}>
                    {(mime) => <div class="px-3 py-2 text-12-regular text-text-weak">{mime()}</div>}
                  </Show>
                </div>
              )
            }

            return (
              <div class="flex flex-col bg-background-stronger">
                <Show when={hasActions()}>
                  <div class="flex justify-end px-3 py-2">{actions()}</div>
                </Show>
                <div class="flex justify-center px-6 pb-4">
                  <audio class="w-full max-w-xl" controls preload="metadata" onLoadedMetadata={onLoad}>
                    <source src={value()} type={audioMime()} />
                  </audio>
                </div>
              </div>
            )
          }}
        </Show>
      </Match>
      <Match when={kind() === "svg"}>
        {(() => {
          if (svgSource() === undefined && svgSrc() == null) return props.fallback()

          return (
            <div class="flex flex-col gap-4 px-6 py-4">
              <Show when={svgSource() !== undefined}>{props.fallback()}</Show>
              <Show when={svgSrc()}>
                {(value) => (
                  <div class="flex justify-center">
                    <img
                      src={value()}
                      alt={cfg()?.path}
                      class="max-h-[60vh] max-w-full rounded border border-border-weak-base bg-background-base object-contain"
                      onLoad={onLoad}
                    />
                  </div>
                )}
              </Show>
            </div>
          )
        })()}
      </Match>
      <Match when={isBinary()}>
        <div class="flex min-h-56 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <div class="text-14-semibold text-text-strong">
            {cfg()?.path?.split("/").pop() ?? i18n.t("ui.fileMedia.binary.title")}
          </div>
          <div class="text-14-regular text-text-weak">
            {(() => {
              const path = cfg()?.path
              if (!path) return i18n.t("ui.fileMedia.binary.description.default")
              return i18n.t("ui.fileMedia.binary.description.path", { path })
            })()}
          </div>
          <Show when={hasActions()}>
            <div class="pt-1">{actions()}</div>
          </Show>
        </div>
      </Match>
      <Match when={true}>{props.fallback()}</Match>
    </Switch>
  )
}
