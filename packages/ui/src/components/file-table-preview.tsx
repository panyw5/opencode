import { createMemo, For, Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { registerFileViewer, fileViewerTarget, type FileViewerProps } from "./file-viewer-registry"
import { parseDelimitedText } from "./file-preview-model"

export function FileTablePreview(props: FileViewerProps) {
  const i18n = useI18n()
  const table = createMemo(() => {
    const source = props.text
    if (source === undefined) return
    return parseDelimitedText(source, fileViewerTarget(props.path).extension === "tsv" ? "\t" : undefined)
  })

  return (
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
  )
}

registerFileViewer({
  id: "builtin:table",
  owner: "builtin",
  title: "Table",
  mode: "preview",
  priority: 0,
  extensions: ["csv", "tsv"],
  component: FileTablePreview,
})
