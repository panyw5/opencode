import { describe, expect, test } from "bun:test"
import { createRoot, createSignal, type Component } from "solid-js"
import { extensionScopedMount } from "../src/extensions/mount"

function textComponent(): Component<{ label: string }> {
  return (props) => {
    const el = document.createElement("span")
    el.className = "tool-body"
    el.textContent = props.label
    return el
  }
}

describe("extension scoped mount", () => {
  test("wraps a contributed component in a data-extension scope root", () => {
    createRoot((dispose) => {
      const Wrapped = extensionScopedMount("acme.demo", textComponent())
      const root = Wrapped({ label: "hello" }) as HTMLElement
      document.body.append(root)

      expect(root.tagName).toBe("DIV")
      expect(root.className).toContain("oc-extension-root")
      expect(root.dataset.extension).toBe("acme.demo")
      // The scope selector emitted by the extension-kit build matches the root.
      expect(root.matches('[data-extension="acme.demo"]')).toBe(true)
      expect(root.querySelector(".tool-body")?.textContent).toBe("hello")
      expect(document.querySelectorAll('[data-extension="acme.demo"]')).toHaveLength(1)
      root.remove()
      dispose()
    })
  })

  test("forwards the original props object untouched to the wrapped component", () => {
    createRoot((dispose) => {
      const seen: Array<Record<string, unknown>> = []
      const Inner: Component<{ label: string }> = (props) => {
        seen.push(props as never)
        return document.createElement("span")
      }
      const Wrapped = extensionScopedMount("acme.demo", Inner)
      const props = { label: "hello" }
      const root = Wrapped(props) as HTMLElement
      document.body.append(root)

      expect(seen[0]).toBe(props)
      expect(seen[0].label).toBe("hello")
      root.remove()
      dispose()
    })
  })

  test("handles components returning multiple nodes and raw text", () => {
    createRoot((dispose) => {
      const Multi: Component = () => {
        const first = document.createElement("b")
        first.textContent = "one"
        return [first, "two"] as unknown as HTMLElement
      }
      const Wrapped = extensionScopedMount("acme.other", Multi)
      const root = Wrapped({} as never) as HTMLElement
      document.body.append(root)

      expect(root.dataset.extension).toBe("acme.other")
      expect(root.textContent).toBe("onetwo")
      root.remove()
      dispose()
    })
  })

  // Regression: a manual `append` snapshots accessor children (props.children
  // getters, <Show> instances) as dead values, so later signal changes never
  // reach the mounted DOM. `insert` keeps them live.
  test("keeps accessor children live across reactive signal changes", async () => {
    await createRoot(async (dispose) => {
      const [label, setLabel] = createSignal("first")
      const Reactive: Component = () => {
        return () => {
          const el = document.createElement("span")
          el.className = "reactive-body"
          el.textContent = label()
          return el
        }
      }
      const Wrapped = extensionScopedMount("acme.reactive", Reactive)
      const root = Wrapped({} as never) as HTMLElement
      document.body.append(root)

      expect(root.querySelector(".reactive-body")?.textContent).toBe("first")

      setLabel("second")
      await Promise.resolve()
      await Promise.resolve()
      expect(root.querySelector(".reactive-body")?.textContent).toBe("second")
      root.remove()
      dispose()
    })
  })

  // Regression: a manual `append` stringifies nested arrays (e.g. an array
  // holding a child accessor produced by compiled JSX), turning them into
  // garbage text nodes. `insert` flattens and mounts them as real nodes.
  test("keeps nested-array children live instead of stringifying them", async () => {
    await createRoot(async (dispose) => {
      const [extra, setExtra] = createSignal("tail")
      const Nested: Component = () => {
        const head = document.createElement("b")
        head.textContent = "head"
        return [head, () => document.createTextNode(extra())] as unknown as HTMLElement
      }
      const Wrapped = extensionScopedMount("acme.nested", Nested)
      const root = Wrapped({} as never) as HTMLElement
      document.body.append(root)

      expect(root.querySelector("b")?.textContent).toBe("head")
      expect(root.textContent).not.toContain("function")
      expect(root.textContent).toContain("tail")

      setExtra("changed")
      await Promise.resolve()
      await Promise.resolve()
      expect(root.textContent).toContain("changed")
      root.remove()
      dispose()
    })
  })
})
