import { For, Show, createEffect, createSignal } from "solid-js"
import { Portal } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { userMessageRailHeight, userMessageRailMarkWidth } from "@/pages/session/session-user-message-rail-model"

export type SessionUserMessageEntry = {
  id: string
  text: string
  created: number
}

function formatMessageTime(value: number, locale: string): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

export function SessionUserMessageRail(props: {
  entries: SessionUserMessageEntry[]
  loading: boolean
  complete: boolean
  onOpen: (entry: SessionUserMessageEntry) => void
}) {
  const language = useLanguage()
  const [preview, setPreview] = createSignal<{
    index: number
    entry: SessionUserMessageEntry
    left: number
    top: number
  }>()
  const hovered = () => preview()?.index

  createEffect(() => {
    console.debug(
      `[user-message-rail] render count=${String(props.entries.length)} loading=${String(props.loading)} complete=${String(props.complete)}`,
    )
  })

  const activate = (
    index: number,
    entry: SessionUserMessageEntry,
    source: "pointer" | "focus",
    target: HTMLButtonElement,
  ) => {
    const rect = target.getBoundingClientRect()
    setPreview({
      index,
      entry,
      left: rect.right + 12,
      top: Math.max(12, Math.min(window.innerHeight - 132, rect.top + rect.height / 2 - 56)),
    })
    console.debug(`[user-message-rail] preview source=${source} index=${String(index)} id=${entry.id}`)
  }

  const deactivate = (index: number) => {
    if (hovered() !== index) return
    setPreview(undefined)
    console.debug(`[user-message-rail] preview-close index=${String(index)}`)
  }

  return (
    <Show when={props.entries.length > 0}>
      <>
        <nav
          data-testid="session-user-message-rail"
          aria-label={language.t("session.userMessages.menuLabel")}
          class="pointer-events-none absolute inset-y-0 left-0 z-[55] hidden w-16 items-center justify-center md:flex"
        >
          <div
            class="pointer-events-auto flex max-h-[min(64vh,520px)] w-full flex-col py-1"
            style={{ height: `${String(userMessageRailHeight(props.entries.length))}px` }}
          >
            <For each={props.entries}>
              {(entry, index) => {
                const label = () =>
                  `${language.t("session.userMessages.index", { index: index() + 1 })}: ${entry.text}`

                return (
                  <div class="min-h-0 flex-1">
                    <button
                      type="button"
                      data-testid="session-user-message-rail-item"
                      data-message-id={entry.id}
                      aria-label={label()}
                      aria-describedby={hovered() === index() ? `user-message-preview-${entry.id}` : undefined}
                      class="group flex size-full items-center pl-3 outline-none"
                      onPointerEnter={(event) => activate(index(), entry, "pointer", event.currentTarget)}
                      onPointerLeave={() => deactivate(index())}
                      onFocus={(event) => activate(index(), entry, "focus", event.currentTarget)}
                      onBlur={() => deactivate(index())}
                      onClick={() => {
                        console.debug(`[user-message-rail] select index=${String(index())} id=${entry.id}`)
                        props.onOpen(entry)
                      }}
                    >
                      <span
                        aria-hidden="true"
                        classList={{
                          "block h-0.5 rounded-full transition-[width,background-color,opacity] duration-150 ease-out motion-reduce:transition-none":
                            true,
                          "bg-text-strong opacity-100": hovered() === index(),
                          "bg-text-weak opacity-70": hovered() !== index() && hovered() !== undefined,
                          "bg-border-strong-base opacity-75": hovered() === undefined,
                        }}
                        style={{ width: `${String(userMessageRailMarkWidth(index(), hovered()))}px` }}
                      />
                    </button>
                  </div>
                )
              }}
            </For>
          </div>
        </nav>
        <Show when={preview()}>
          {(value) => (
            <Portal>
              <div
                id={`user-message-preview-${value().entry.id}`}
                data-testid="session-user-message-preview"
                role="tooltip"
                class="pointer-events-none fixed z-[1000] w-[min(420px,calc(100vw-96px))] rounded-[14px] border border-border-weak-base bg-background-stronger px-4 py-3.5 text-text-strong shadow-md"
                style={{ left: `${String(value().left)}px`, top: `${String(value().top)}px` }}
              >
                <div class="mb-1 flex items-center gap-2 text-11-medium text-text-weak">
                  <span>{language.t("session.userMessages.index", { index: value().index + 1 })}</span>
                  <Show when={formatMessageTime(value().entry.created, language.intl())}>
                    {(time) => <span>{time()}</span>}
                  </Show>
                </div>
                <div class="line-clamp-4 whitespace-pre-wrap break-words text-13-regular leading-5 text-text-strong">
                  {value().entry.text}
                </div>
              </div>
            </Portal>
          )}
        </Show>
      </>
    </Show>
  )
}
