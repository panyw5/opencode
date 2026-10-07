import fs from "node:fs"
import { describe, expect, test } from "bun:test"
import { extensionScopeSelector, scopeSelector } from "../../../extension-kit/scope.js"

const ID = "example.scope-dom"
const SCOPE = extensionScopeSelector(ID)

// The scoped stylesheet the extension-kit build emits; these selectors are
// produced by scopeSelector() exactly the way the vite build rewrites them.
const scope = (selector: string) => scopeSelector(selector, SCOPE)
const rule = (selectors: string[], body: string) => `${selectors.map(scope).join(",\n")} {\n  ${body}\n}`
const stylesheet = [
  rule([".scope-fixture-title", '[data-note="a,b"].scope-fixture-tag:before'], "color: var(--scope-fixture-accent);"),
  rule([".scope-fixture-panel :is(.scope-fixture-a, .scope-fixture-b)"], "border: 1px solid red;"),
  rule([":root"], "--scope-fixture-accent: hotpink;"),
].join("\n")

// A host page that collides with the extension's class names.
const page = () => {
  const host = document.createElement("div")
  host.innerHTML = `
    <section data-testid="host-page">
      <span class="scope-fixture-title">host title</span>
      <span data-note="a,b" class="scope-fixture-tag">host tag</span>
      <div class="scope-fixture-panel"><span class="scope-fixture-a">host a</span></div>
    </section>
    <div class="oc-extension-root" data-extension="${ID}">
      <section class="scope-fixture-root">
        <span class="scope-fixture-title">ext title</span>
        <span data-note="a,b" class="scope-fixture-tag">ext tag</span>
        <div class="scope-fixture-panel"><span class="scope-fixture-a">ext a</span></div>
      </section>
    </div>
  `
  document.body.append(host)
  return host
}

describe("extension CSS scope against the host DOM", () => {
  test("scoped selectors only match nodes inside the extension mount", () => {
    const host = page()

    const titles = [...host.querySelectorAll(scopeSelector(".scope-fixture-title", SCOPE))]
    expect(titles).toHaveLength(1)
    expect(titles[0].textContent).toBe("ext title")

    // A comma inside the attribute selector survives; pseudo-elements are
    // asserted on the stylesheet string below (querySelectorAll never matches
    // pseudo-elements, not even in browsers).
    const tags = [...host.querySelectorAll(scopeSelector('[data-note="a,b"].scope-fixture-tag', SCOPE))]
    expect(tags).toHaveLength(1)
    expect(tags[0].textContent).toBe("ext tag")

    // Complex :is() selectors stay constrained by the mount prefix.
    const panelItems = [...host.querySelectorAll(scopeSelector(".scope-fixture-panel :is(.scope-fixture-a)", SCOPE))]
    expect(panelItems).toHaveLength(1)
    expect(panelItems[0].textContent).toBe("ext a")

    // Sanity: without the scope prefix the same selectors would hit host DOM.
    expect(host.querySelectorAll(".scope-fixture-title")).toHaveLength(2)
    expect(host.querySelectorAll('[data-note="a,b"].scope-fixture-tag')).toHaveLength(2)
    host.remove()
  })

  test("emits the expected scoped stylesheet", () => {
    expect(stylesheet).toContain(`${SCOPE} [data-note="a,b"].scope-fixture-tag:before`)
    expect(stylesheet).toContain(`${SCOPE} .scope-fixture-title,`)
    expect(stylesheet).toContain(`${SCOPE} .scope-fixture-panel :is(.scope-fixture-a, .scope-fixture-b)`)
    // :root variables land on the mount root, never on the host document root.
    expect(stylesheet).toContain(`${SCOPE} {\n  --scope-fixture-accent: hotpink;`)
    expect(stylesheet).not.toMatch(/^:root/m)
  })

  test("viewer and panel mounts carry the data-extension scope attribute", () => {
    // The mount markup lives in Solid components that bun tests cannot import
    // (JSX is compiled for Solid, not React), so pin the contract on source.
    // The file viewer mount is built by the render boundary helper that
    // file-tabs.tsx wires up, so both sources carry the markers.
    const viewerContent = fs.readFileSync(new URL("../pages/session/file-viewer-content.ts", import.meta.url), "utf8")
    expect(viewerContent).toContain("oc-extension-root")
    expect(viewerContent).toContain("data-extension")
    expect(viewerContent).toContain("data-file-viewer")
    const panelContent = fs.readFileSync(new URL("./panel-content.tsx", import.meta.url), "utf8")
    expect(panelContent).toContain("oc-extension-root")
    expect(panelContent).toContain("data-extension=")
  })
})
