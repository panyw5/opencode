import { For, Show, createEffect, createMemo, untrack, type JSXElement } from "solid-js"
import { createStore } from "solid-js/store"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import type { ChangeKind, ChangeTreeEntry, ChangeTreeNode } from "@/pages/session/change-tree-model"
import { buildChangeTree } from "@/pages/session/change-tree-model"

/**
 * Pure-path change tree for the "changes" tab
 * (specs/performance/right-side-panels-optimization.md §5.5).
 *
 * Renders straight from the change manifest — no filesystem listings, no
 * `file.tree` involvement, and an expansion state fully independent from the
 * all-files tree, so expanding changed ancestors never pollutes the "all" tab.
 * Deleted paths render like any other change.
 */

const kindLabel = (kind: ChangeKind) => {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

const kindTextColor = (kind: ChangeKind) => {
  if (kind === "add") return "color: var(--icon-diff-add-base)"
  if (kind === "del") return "color: var(--icon-diff-delete-base)"
  return "color: var(--icon-diff-modified-base)"
}

const kindDotColor = (kind: ChangeKind) => {
  if (kind === "add") return "background-color: var(--icon-diff-add-base)"
  if (kind === "del") return "background-color: var(--icon-diff-delete-base)"
  return "background-color: var(--icon-diff-modified-base)"
}

export default function ChangeTree(props: {
  entries: readonly ChangeTreeEntry[]
  foldCase?: boolean
  active?: string
  class?: string
  onFileClick?: (path: string) => void
}) {
  const tree = createMemo(() => buildChangeTree(props.entries, { foldCase: props.foldCase ?? false }))

  // Expansion state owned by this tree (independent of file.tree): new
  // directories start expanded so the changed subtree is visible, and users
  // can collapse any folder.
  const [expanded, setExpanded] = createStore({} as Record<string, boolean>)
  createEffect(() => {
    for (const node of tree().index.values()) {
      if (node.type === "directory" && node.key && untrack(() => expanded[node.key]) === undefined) {
        setExpanded(node.key, true)
      }
    }
  })

  const isOpen = (node: ChangeTreeNode) => expanded[node.key] ?? false

  const toggle = (node: ChangeTreeNode, next: boolean) => {
    setExpanded(node.key, next)
  }

  const renderRows = (nodes: ChangeTreeNode[], level: number): JSXElement => (
    <For each={nodes}>
      {(node) => (
        <Show
          when={node.type === "file"}
          fallback={
            <>
              <button
                type="button"
                class="w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors cursor-pointer [contain:layout_style_paint]"
                classList={{ "bg-surface-base-active": props.active === node.path }}
                style={`padding-left: ${Math.max(0, 8 + level * 12 - 4)}px`}
                aria-expanded={isOpen(node)}
                onClick={() => toggle(node, !isOpen(node))}
              >
                <FileIcon node={{ path: node.path, type: "directory" }} expanded={isOpen(node)} />
                <span
                  classList={{
                    "flex-1 min-w-0 text-12-medium whitespace-nowrap truncate text-text-weak": true,
                  }}
                  style={kindTextColor(node.kind)}
                >
                  {node.name}
                </span>
                <div class="shrink-0 size-1.5 mr-1.5 rounded-full" style={kindDotColor(node.kind)} />
                <span data-slot="change-tree-chevron" class="shrink-0 text-text-weaker">
                  <Icon name={isOpen(node) ? "chevron-down" : "chevron-right"} size="small" />
                </span>
              </button>
              <Show when={isOpen(node)}>{renderRows(node.children, level + 1)}</Show>
            </>
          }
        >
          <button
            type="button"
            class="w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors cursor-pointer [contain:layout_style_paint]"
            classList={{ "bg-surface-base-active": props.active === node.path }}
            style={`padding-left: ${Math.max(0, 8 + level * 12 - 24)}px`}
            onClick={() => props.onFileClick?.(node.path)}
          >
            <FileIcon node={{ path: node.path, type: "file" }} mono class="text-text-weak" />
            <span
              class="flex-1 min-w-0 text-12-medium whitespace-nowrap truncate"
              style={kindTextColor(node.kind)}
            >
              {node.name}
            </span>
            <span class="shrink-0 w-4 text-center text-12-medium" style={kindTextColor(node.kind)}>
              {kindLabel(node.kind)}
            </span>
          </button>
        </Show>
      )}
    </For>
  )

  return (
    <div
      data-component="change-tree"
      role="tree"
      aria-label="Changed files"
      class={`flex flex-col gap-0.5 ${props.class ?? ""}`}
    >
      {renderRows(tree().root.children, 0)}
    </div>
  )
}
