import { describe, expect, spyOn, test } from "bun:test"
import { createEffect, createRoot, createSignal, onCleanup, type Component } from "solid-js"
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

  test("contains setup errors, reports the tool, and retries with the same props", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      await createRoot(async (dispose) => {
        let fail = true
        let attempts = 0
        const seen: object[] = []
        const props = { label: "recovered" }
        const Wrapped = extensionScopedMount(
          "acme.demo",
          (input: typeof props) => {
            attempts++
            seen.push(input)
            if (fail) throw new Error("setup failed")
            return textComponent()(input)
          },
          "demo_tool",
        )
        let root: HTMLElement | undefined
        try {
          root = Wrapped(props) as HTMLElement
          document.body.append(root)
          await Promise.resolve()
          expect(root.dataset.extension).toBe("acme.demo")
          expect(root.textContent).toContain("demo_tool")
          expect(root.textContent).toContain("setup failed")
          expect(root.querySelector("button")?.textContent).toBe("Retry")
          expect(log.mock.calls).toHaveLength(1)
          expect(log.mock.calls[0]).toHaveLength(1)
          expect(typeof log.mock.calls[0][0]).toBe("string")
          expect(log.mock.calls[0][0]).toContain("acme.demo")
          expect(log.mock.calls[0][0]).toContain("demo_tool")
          fail = false
          root.querySelector("button")!.click()
          expect(root.querySelector(".tool-body")?.textContent).toBe("recovered")
          expect(root.querySelector("button")).toBeNull()
          expect(attempts).toBe(2)
          expect(seen).toEqual([props, props])
          expect(seen.every((value) => value === props)).toBe(true)
        } finally {
          root?.remove()
          dispose()
        }
      })
    } finally {
      log.mockRestore()
    }
  })

  test("renders a disable button next to retry that invokes the disable callback", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      await createRoot(async (dispose) => {
        let disabled = 0
        const Wrapped = extensionScopedMount(
          "acme.demo",
          () => {
            throw new Error("setup failed")
          },
          "demo_tool",
          { disable: () => disabled++ },
        )
        let root: HTMLElement | undefined
        try {
          root = Wrapped({}) as HTMLElement
          document.body.append(root)
          await Promise.resolve()
          const buttons = [...root.querySelectorAll("button")]
          expect(buttons.map((button) => button.textContent)).toEqual(["Retry", "Disable extension"])
          expect(buttons[1].dataset.action).toBe("disable-extension")
          buttons[1].click()
          await Promise.resolve()
          expect(disabled).toBe(1)
          // Retrying still works after a declined disable.
          root.querySelector("button")!.click()
        } finally {
          root?.remove()
          dispose()
        }
      })
    } finally {
      log.mockRestore()
    }
  })

  test("contains an accessor error during the initial insert", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      await createRoot(async (dispose) => {
        const Wrapped = extensionScopedMount(
          "acme.demo",
          () => () => {
            throw new Error("initial accessor failed")
          },
          "demo_tool",
        )
        let root: HTMLElement | undefined
        try {
          root = Wrapped({}) as HTMLElement
          await Promise.resolve()
          expect(root.textContent).toContain("initial accessor failed")
          expect(root.textContent).toContain("demo_tool")
          expect(root.querySelector("button")?.textContent).toBe("Retry")
        } finally {
          root?.remove()
          dispose()
        }
      })
    } finally {
      log.mockRestore()
    }
  })

  test("contains reactive insert errors without affecting siblings and cleans up on retry", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      await createRoot(async (dispose) => {
        const [fail, setFail] = createSignal(false)
        const [label, setLabel] = createSignal("first")
        let cleanups = 0
        const Wrapped = extensionScopedMount(
          "acme.demo",
          () => {
            onCleanup(() => cleanups++)
            return () => {
              if (fail()) throw new Error("reactive accessor failed")
              return document.createTextNode(label())
            }
          },
          "demo_tool",
        )
        const Sibling = extensionScopedMount("acme.sibling", () => () => document.createTextNode(label()))
        let root: HTMLElement | undefined
        let sibling: HTMLElement | undefined
        try {
          root = Wrapped({}) as HTMLElement
          sibling = Sibling({}) as HTMLElement
          document.body.append(root, sibling)
          expect(root.textContent).toBe("first")
          setFail(true)
          await Promise.resolve()
          expect(root.textContent).toContain("reactive accessor failed")
          expect(root.textContent).toContain("demo_tool")
          expect(cleanups).toBe(1)
          setLabel("second")
          expect(sibling.textContent).toBe("second")
          setFail(false)
          root.querySelector("button")!.click()
          expect(root.textContent).toBe("second")
          setLabel("third")
          expect(root.textContent).toBe("third")
          expect(sibling.textContent).toBe("third")
        } finally {
          root?.remove()
          sibling?.remove()
          dispose()
        }
        expect(cleanups).toBe(2)
      })
    } finally {
      log.mockRestore()
    }
  })

  test("contains errors in effects owned by the contributed component", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      await createRoot(async (dispose) => {
        const [fail, setFail] = createSignal(false)
        const Wrapped = extensionScopedMount(
          "acme.demo",
          () => {
            createEffect(() => {
              if (fail()) throw new Error("effect failed")
            })
            return document.createTextNode("healthy")
          },
          "demo_tool",
        )
        let root: HTMLElement | undefined
        try {
          root = Wrapped({}) as HTMLElement
          document.body.append(root)
          await Promise.resolve()
          setFail(true)
          await Promise.resolve()
          expect(root.textContent).toContain("effect failed")
          expect(root.textContent).toContain("demo_tool")
        } finally {
          root?.remove()
          dispose()
        }
      })
    } finally {
      log.mockRestore()
    }
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
