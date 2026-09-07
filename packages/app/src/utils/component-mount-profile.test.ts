import { describe, expect, test } from "bun:test"
import { createComponentMountRegistry } from "./component-mount-profile"

describe("component mount profile", () => {
  test("tracks active mounts and balanced unmounts", () => {
    const lines: string[] = []
    const registry = createComponentMountRegistry((line) => lines.push(line))
    const disposeOne = registry.mount({ name: "MessageTimeline", session: "one" })
    const disposeTwo = registry.mount({ name: "MessageTimeline", session: "two" })
    expect(registry.snapshot().MessageTimeline).toMatchObject({ active: 2, mounts: 2, unmounts: 0 })

    disposeOne()
    disposeOne()
    expect(registry.snapshot().MessageTimeline).toMatchObject({ active: 1, mounts: 2, unmounts: 1 })
    disposeTwo()
    expect(registry.snapshot().MessageTimeline).toMatchObject({ active: 0, mounts: 2, unmounts: 2 })
    expect(lines).toHaveLength(4)
  })
})
