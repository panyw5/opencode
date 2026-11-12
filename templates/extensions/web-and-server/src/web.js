// This template has no build step and no npm dependencies. The host publishes
// its shared modules (solid-js, solid-js/web, solid-js/store,
// @opencode-ai/ui/*) on this global before loading the web entry; production
// extensions usually consume them through @opencode-ai/extension-kit shims.
const solid = globalThis.__OPENCODE_EXTENSION_HOST__?.modules?.["solid-js"]

// A Solid component is any function returning JSX/DOM output, so a plain
// function that returns an element works without a build step. `props.text`
// is an accessor: read it inside a reactive effect when solid is available,
// otherwise render once.
function StarterViewer(props) {
  const root = document.createElement("div")
  root.className = "oc-web-starter"
  const title = document.createElement("strong")
  title.className = "oc-web-starter-title"
  title.textContent = "Starter Viewer"
  const path = document.createElement("div")
  path.className = "oc-web-starter-path"
  path.textContent = props.file?.path ?? ""
  const pre = document.createElement("pre")
  pre.className = "oc-web-starter-body"
  root.append(title, path, pre)
  const render = () => {
    const text = typeof props.text === "function" ? props.text() : undefined
    pre.textContent = text === undefined ? "(content unavailable)" : text || "(empty file)"
  }
  if (solid?.createEffect) solid.createEffect(render)
  else render()
  return root
}

export default {
  // Must match package.json opencode.id; the host verifies it at activation.
  id: "example.web-extension-starter",
  apiVersion: 1,
  activate(context) {
    context.fileViewers.register({ id: "starter", component: StarterViewer })
    context.log.info("web-extension-starter activated")
  },
}
