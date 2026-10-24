import { expect, test } from "bun:test"
import { createFileRevalidation } from "./revalidation"

test("all sources coalesce; hidden entries are dirtied without reads", () => {
  let visible = ["image.svg"]
  const stale = new Set<string>()
  const reads: string[] = []
  const service = createFileRevalidation({
    visible: () => visible,
    stale: (file) => {
      stale.add(file)
    },
    load: async (file) => {
      reads.push(file)
    },
  })
  for (const reason of ["native", "tool", "flood", "foreground", "reconnect"]) {
    service.invalidate("image.svg", reason)
    service.invalidate("hidden.svg", reason)
  }
  service.flush()
  expect(reads).toEqual(["image.svg"])
  expect([...stale]).toEqual(["image.svg", "hidden.svg"])
  service.visible("reconnect")
  visible = []
  service.flush()
  expect(reads).toEqual(["image.svg"])
  service.reset()
})

test("scope reset and manual refresh cannot leave a delayed duplicate read", async () => {
  const reads: string[] = []
  const service = createFileRevalidation({
    visible: () => ["a"],
    stale: () => {},
    load: async (file) => {
      reads.push(file)
    },
  })
  service.visible("reconnect")
  service.reset()
  service.flush()
  expect(reads).toEqual([])
  service.visible("foreground")
  await service.refresh("a")
  service.flush()
  expect(reads).toEqual(["a"])
  service.reset()
})
