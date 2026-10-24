import { expect, test } from "bun:test"
import { watchVisibleFile } from "./visible-watch"

test("explicit reconnect re-subscribes and disposal releases the live request", async () => {
  let subscriptions = 0
  let aborts = 0
  const changes: string[] = []
  const watch = watchVisibleFile({
    subscribe: async (signal) => {
      subscriptions++
      return {
        stream: (async function* () {
          yield { type: "file.watcher.updated", properties: { file: "a" } }
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                aborts++
                resolve()
              },
              { once: true },
            ),
          )
        })(),
      }
    },
    change: (event) => {
      changes.push(event.type)
    },
  })
  for (let i = 0; i < 50 && changes.length < 1; i++) await Bun.sleep(10)
  expect(subscriptions).toBe(1)
  watch.reconnect()
  for (let i = 0; i < 150 && changes.length < 2; i++) await Bun.sleep(10)
  expect(subscriptions).toBe(2)
  watch.dispose()
  expect(aborts).toBe(2)
})
