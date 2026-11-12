import { createComponent, ErrorBoundary, type Component } from "solid-js"
import { insert } from "solid-js/web"
import { markExtensionFailure } from "./safe-mode"

// DOM mount contract for extension CSS scoping. The extension-kit vite build
// prefixes every selector with `[data-extension="<id>"]` (see
// packages/extension-kit/scope.js), so every surface an extension renders must
// live inside an element carrying `data-extension="<id>"`:
//
// - file viewers: the mount is rendered by file-tabs.tsx (`oc-extension-root`
//   with `data-extension` and `data-file-viewer`).
// - side panels: the mount is rendered by panel-content.tsx.
// - tool renderers: the host tool registry mounts the contributed component
//   directly, so registrations must wrap it with `extensionScopedMount` (see
//   host.tsx `registerToolRenderer`).

/**
 * Wrap an extension-contributed component so it renders inside a
 * `<div class="oc-extension-root" data-extension="<extensionID>">` scope root.
 *
 * The wrapper forwards the original props object untouched, so Solid prop
 * reactivity is preserved.
 *
 * Children are mounted with solid's `insert`, not a manual `append`: a
 * component may return an accessor (a `props.children` getter, a `<Show>`
 * instance) or a nested array of nodes, and `append` would snapshot those into
 * dead strings/objects. `insert` keeps them live so reactive signal changes
 * still update the mounted DOM.
 *
 * `insert` is a client-only API (the server build of `solid-js/web` stubs it),
 * and it must come from the same condition-resolved solid instance as the rest
 * of the app for cross-module owner/signal tracking to work. Reactive mount
 * behavior is therefore covered by the browser-condition suite in
 * `packages/app/test-browser/extension-mount.test.ts` (run via
 * `bun test --conditions=browser`), not by hacking this file or the default
 * server-condition suite.
 */
export function extensionScopedMount<P extends Record<string, any>>(
  extensionID: string,
  component: Component<P>,
  tool = extensionID,
  options?: { disable?: () => unknown },
): Component<P> {
  return (props: P) => {
    const root = document.createElement("div")
    root.className = "oc-extension-root"
    root.dataset.extension = extensionID
    insert(
      root,
      createComponent(ErrorBoundary, {
        fallback(error, reset) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[extension-tool] render failed id=${extensionID} tool=${tool} error=${message}`)
          markExtensionFailure()
          const fallback = document.createElement("div")
          fallback.className = "flex flex-col gap-2 p-3 text-text-weak"
          const title = document.createElement("div")
          title.textContent = `Tool renderer failed: ${tool}`
          const detail = document.createElement("div")
          detail.className = "break-words"
          detail.textContent = message
          const retry = document.createElement("button")
          retry.type = "button"
          retry.className = "self-start text-text-strong underline"
          retry.textContent = "Retry"
          retry.onclick = () => {
            console.info(`[extension-tool] render retry id=${extensionID} tool=${tool}`)
            reset()
          }
          fallback.append(title, detail, retry)
          if (options?.disable) {
            const disable = document.createElement("button")
            disable.type = "button"
            disable.className = "self-start text-text-strong underline"
            disable.dataset.action = "disable-extension"
            disable.textContent = "Disable extension"
            disable.onclick = () => {
              console.info(`[extension-tool] disable requested id=${extensionID} tool=${tool}`)
              try {
                void Promise.resolve(options.disable!())
              } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                console.warn(`[extension-tool] disable failed id=${extensionID} tool=${tool} error=${reason}`)
              }
            }
            fallback.append(disable)
          }
          return fallback
        },
        get children() {
          // Both setup and insert must run under the boundary owner: insert can
          // evaluate accessors now or create computations that fail on updates.
          // A fresh mount also prevents failed/retried inserts sharing DOM state.
          const content = document.createElement("div")
          content.className = "contents"
          insert(content, component(props))
          return content
        },
      }),
    )
    return root
  }
}

export type ExtensionDisableRequest = {
  id: string
  // Where the disable was triggered from (tool renderer, panel, viewer
  // placeholder); logged for debugging.
  surface: string
  setEnabled(id: string, enabled: boolean): Promise<unknown>
}

// Shared "disable this extension" action for every extension error fallback.
// The host's setEnabled reconciles registrations and open surfaces (panels
// fall back to the unavailable view, tool renderers restore the previous
// registration), so the button never mutates registries directly. The
// returned promise never rejects: toggle failures are logged, not thrown.
export function requestExtensionDisable(input: ExtensionDisableRequest) {
  console.info(`[extension-disable] requested id=${input.id} surface=${input.surface}`)
  return Promise.resolve(input.setEnabled(input.id, false)).then(
    () => console.info(`[extension-disable] disabled id=${input.id} surface=${input.surface}`),
    (error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[extension-disable] failed id=${input.id} surface=${input.surface} error=${message}`)
    },
  )
}
