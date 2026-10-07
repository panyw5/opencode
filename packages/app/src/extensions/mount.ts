import type { Component } from "solid-js"
import { insert } from "solid-js/web"

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
export function extensionScopedMount<P extends Record<string, any>>(extensionID: string, component: Component<P>): Component<P> {
  return (props: P) => {
    const root = document.createElement("div")
    root.className = "oc-extension-root"
    root.dataset.extension = extensionID
    insert(root, component(props))
    return root
  }
}
