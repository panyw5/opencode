import { describe, expect, test, beforeEach } from "bun:test"
import { createUpdaterController, type UpdaterBackend, type UpdaterState } from "./updater-controller"

function createMockBackend(overrides: Partial<UpdaterBackend> = {}): UpdaterBackend {
  return {
    checkForUpdates: async () => null,
    downloadUpdate: async () => {},
    quitAndInstall: () => {},
    ...overrides,
  }
}

function createMockPersistence() {
  let stored: { version: string } | undefined
  return {
    get: async () => stored,
    set: async (value: { version: string }) => {
      stored = value
    },
    clear: async () => {
      stored = undefined
    },
    _getStored: () => stored,
  }
}

function collectStates(controller: ReturnType<typeof createUpdaterController>) {
  const states: UpdaterState[] = []
  controller.subscribe((state) => states.push(state))
  return states
}

describe("createUpdaterController", () => {
  describe("initial state", () => {
    test("starts as idle when enabled", () => {
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend(),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      expect(ctrl.getState()).toEqual({ status: "idle" })
    })

    test("starts as disabled when not enabled", () => {
      const ctrl = createUpdaterController({
        enabled: false,
        currentVersion: "1.0.0",
        backend: createMockBackend(),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      expect(ctrl.getState()).toEqual({ status: "disabled" })
    })
  })

  describe("check", () => {
    test("returns disabled state immediately when not enabled", async () => {
      const ctrl = createUpdaterController({
        enabled: false,
        currentVersion: "1.0.0",
        backend: createMockBackend(),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      const result = await ctrl.check()
      expect(result).toEqual({ status: "disabled" })
    })

    test("transitions to up-to-date when no update is available", async () => {
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({ isUpdateAvailable: false }),
        }),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      const states = collectStates(ctrl)
      const result = await ctrl.check()
      expect(result.status).toBe("up-to-date")
      expect(states.map((s) => s.status)).toEqual(["idle", "checking", "up-to-date"])
    })

    test("transitions to error when the backend returns no result", async () => {
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend(),
        persistence: createMockPersistence(),
        stop: async () => {},
      })

      const result = await ctrl.check()
      expect(result).toEqual({ status: "error", message: "Updater returned no check result" })
    })

    test("transitions to error when an available update has no version", async () => {
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({ isUpdateAvailable: true }),
        }),
        persistence: createMockPersistence(),
        stop: async () => {},
      })

      const result = await ctrl.check()
      expect(result).toEqual({ status: "error", message: "Updater reported an update without a version" })
    })

    test("transitions through downloading to ready when update is available", async () => {
      const downloadCalls: string[] = []
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({
            isUpdateAvailable: true,
            updateInfo: { version: "1.1.0" },
          }),
          downloadUpdate: async () => {
            downloadCalls.push("downloaded")
          },
        }),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      const states = collectStates(ctrl)
      const result = await ctrl.check()
      expect(result.status).toBe("ready")
      expect("version" in result && result.version).toBe("1.1.0")
      expect(states.map((s) => s.status)).toEqual(["idle", "checking", "downloading", "ready"])
      expect(downloadCalls).toEqual(["downloaded"])
    })

    test("treats same-version as up-to-date", async () => {
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({
            isUpdateAvailable: true,
            updateInfo: { version: "1.0.0" },
          }),
        }),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      const result = await ctrl.check()
      expect(result.status).toBe("up-to-date")
    })

    test("transitions to error on check failure", async () => {
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => {
            throw new Error("network error")
          },
        }),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      const result = await ctrl.check()
      expect(result.status).toBe("error")
      expect("message" in result && result.message).toBe("network error")
    })

    test("transitions to error on download failure", async () => {
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({
            isUpdateAvailable: true,
            updateInfo: { version: "1.1.0" },
          }),
          downloadUpdate: async () => {
            throw new Error("download failed")
          },
        }),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      const result = await ctrl.check()
      expect(result.status).toBe("error")
      expect("message" in result && result.message).toBe("download failed")
    })

    test("deduplicates concurrent check calls", async () => {
      let checkCount = 0
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => {
            checkCount++
            await new Promise((r) => setTimeout(r, 10))
            return { isUpdateAvailable: false }
          },
        }),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      const [a, b, c] = await Promise.all([ctrl.check(), ctrl.check(), ctrl.check()])
      expect(a.status).toBe("up-to-date")
      expect(b.status).toBe("up-to-date")
      expect(c.status).toBe("up-to-date")
      expect(checkCount).toBe(1)
    })

    test("returns ready state immediately when already ready", async () => {
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({
            isUpdateAvailable: true,
            updateInfo: { version: "1.1.0" },
          }),
        }),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      await ctrl.check()
      expect(ctrl.getState().status).toBe("ready")
      // Second check should return cached ready state without re-calling backend
      const result = await ctrl.check()
      expect(result.status).toBe("ready")
    })
  })

  describe("download controls", () => {
    function fixture() {
      const transfers: Array<{
        progress: (percent: number) => void
        resolve: () => void
        reject: (error: Error) => void
      }> = []
      let cancellations = 0
      const persistence = createMockPersistence()
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "1.1.0" } }),
          downloadUpdate: (progress) =>
            new Promise<void>((resolve, reject) => {
              transfers.push({ progress: progress!, resolve, reject })
            }),
          cancelDownload: () => {
            cancellations++
          },
        }),
        persistence,
        stop: async () => {},
      })
      const started = async (count = 1) => {
        for (let i = 0; i < 20 && transfers.length < count; i++) await Promise.resolve()
        expect(transfers.length).toBe(count)
      }
      return { ctrl, transfers, persistence, started, cancellations: () => cancellations }
    }

    test("publishes clamped progress and ignores invalid values", async () => {
      const f = fixture()
      const check = f.ctrl.check()
      await f.started()
      f.transfers[0].progress(42.5)
      expect(f.ctrl.getState()).toEqual({ status: "downloading", version: "1.1.0", percent: 42.5 })
      f.transfers[0].progress(NaN)
      expect((f.ctrl.getState() as { percent: number }).percent).toBe(42.5)
      f.transfers[0].progress(120)
      expect((f.ctrl.getState() as { percent: number }).percent).toBe(100)
      f.transfers[0].resolve()
      expect((await check).status).toBe("ready")
    })

    test("pause cancels the transport and ignores late completion and progress", async () => {
      const f = fixture()
      const check = f.ctrl.check()
      await f.started()
      f.transfers[0].progress(30)
      f.ctrl.pause()
      expect(f.cancellations()).toBe(1)
      f.transfers[0].progress(100)
      f.transfers[0].resolve()
      expect(await check).toEqual({ status: "paused", version: "1.1.0", percent: 30 })
      expect(f.persistence._getStored()).toBeUndefined()
      expect((await f.ctrl.check()).status).toBe("paused")
    })

    test("resume waits for cancellation and deduplicates concurrent resumes", async () => {
      const f = fixture()
      const check = f.ctrl.check()
      await f.started()
      f.ctrl.pause()
      const a = f.ctrl.resume()
      const b = f.ctrl.resume()
      expect(f.transfers.length).toBe(1)
      f.transfers[0].reject(new Error("cancelled"))
      await check
      await f.started(2)
      expect(f.ctrl.getState()).toEqual({ status: "downloading", version: "1.1.0", percent: 0 })
      f.transfers[1].progress(80)
      f.transfers[1].resolve()
      expect((await a).status).toBe("ready")
      expect((await b).status).toBe("ready")
      expect(f.persistence._getStored()).toEqual({ version: "1.1.0" })
    })

    test("cancel while paused prevents queued resume and allows a fresh check", async () => {
      const f = fixture()
      const check = f.ctrl.check()
      await f.started()
      f.ctrl.pause()
      const resume = f.ctrl.resume()
      const cancel = f.ctrl.cancel()
      f.transfers[0].reject(new Error("cancelled"))
      await Promise.all([check, resume, cancel])
      expect(f.ctrl.getState()).toEqual({ status: "idle" })
      expect(f.transfers.length).toBe(1)
      expect(f.persistence._getStored()).toBeUndefined()
      const next = f.ctrl.check()
      await f.started(2)
      f.transfers[1].resolve()
      expect((await next).status).toBe("ready")
    })

    test("cancel ignores late download success and clears persistence", async () => {
      const f = fixture()
      await f.persistence.set({ version: "old" })
      const check = f.ctrl.check()
      await f.started()
      const cancel = f.ctrl.cancel()
      f.transfers[0].resolve()
      await Promise.all([check, cancel])
      expect(f.ctrl.getState()).toEqual({ status: "idle" })
      expect(f.persistence._getStored()).toBeUndefined()
      await expect(f.ctrl.install()).rejects.toThrow("Update is not ready")
    })
  })

  describe("install", () => {
    test("throws when update is not ready", async () => {
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend(),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      expect(ctrl.install()).rejects.toThrow("Update is not ready to install")
    })

    test("calls stop then quitAndInstall when ready", async () => {
      const callOrder: string[] = []
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({
            isUpdateAvailable: true,
            updateInfo: { version: "1.1.0" },
          }),
          quitAndInstall: () => {
            callOrder.push("quitAndInstall")
          },
        }),
        persistence: createMockPersistence(),
        stop: async () => {
          callOrder.push("stop")
        },
      })
      await ctrl.check()
      const states = collectStates(ctrl)
      await ctrl.install()
      expect(callOrder).toEqual(["stop", "quitAndInstall"])
      expect(states.map((s) => s.status)).toEqual(["ready", "installing", "ready"])
    })

    test("restores ready state when stop fails", async () => {
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({
            isUpdateAvailable: true,
            updateInfo: { version: "1.1.0" },
          }),
        }),
        persistence: createMockPersistence(),
        stop: async () => {
          throw new Error("stop failed")
        },
      })
      await ctrl.check()
      expect(ctrl.install()).rejects.toThrow("stop failed")
      // After failure, state should be back to ready so user can retry
      expect(ctrl.getState().status).toBe("ready")
    })
  })

  describe("subscribe", () => {
    test("emits current state immediately on subscribe", () => {
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend(),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      const states: UpdaterState[] = []
      ctrl.subscribe((state) => states.push(state))
      expect(states).toEqual([{ status: "idle" }])
    })

    test("unsubscribe stops notifications", async () => {
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({ isUpdateAvailable: false }),
        }),
        persistence: createMockPersistence(),
        stop: async () => {},
      })
      const states: UpdaterState[] = []
      const unsub = ctrl.subscribe((state) => states.push(state))
      unsub()
      await ctrl.check()
      // Only the initial state emission, no further updates
      expect(states).toEqual([{ status: "idle" }])
    })
  })

  describe("persistence", () => {
    test("startup does not check or download even when a previous update is recorded", async () => {
      const persistence = createMockPersistence()
      await persistence.set({ version: "1.1.0" })
      let checks = 0
      let downloads = 0
      const logs: string[] = []
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => {
            checks++
            return { isUpdateAvailable: true, updateInfo: { version: "1.1.0" } }
          },
          downloadUpdate: async () => {
            downloads++
          },
        }),
        persistence,
        stop: async () => {},
        log: (message) => logs.push(message),
      })

      expect(await ctrl.start()).toEqual({ status: "idle" })
      expect(checks).toBe(0)
      expect(downloads).toBe(0)
      expect(logs).toContain("updater startup check skipped reason=manual-only")

      expect(await ctrl.check()).toEqual({ status: "ready", version: "1.1.0" })
      expect(checks).toBe(1)
      expect(downloads).toBe(1)
    })

    test("persists ready version after successful download", async () => {
      const persistence = createMockPersistence()
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({
            isUpdateAvailable: true,
            updateInfo: { version: "1.1.0" },
          }),
        }),
        persistence,
        stop: async () => {},
      })
      await ctrl.check()
      expect(persistence._getStored()).toEqual({ version: "1.1.0" })
    })

    test("clears persistence when no update available", async () => {
      const persistence = createMockPersistence()
      await persistence.set({ version: "0.9.0" })
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({ isUpdateAvailable: false }),
        }),
        persistence,
        stop: async () => {},
      })
      await ctrl.check()
      expect(persistence._getStored()).toBeUndefined()
    })

    test("start clears persistence if version matches current", async () => {
      const persistence = createMockPersistence()
      await persistence.set({ version: "1.0.0" })
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({ isUpdateAvailable: false }),
        }),
        persistence,
        stop: async () => {},
      })
      await ctrl.start()
      expect(persistence._getStored()).toBeUndefined()
    })
  })

  describe("logging", () => {
    test("calls log on state transitions", async () => {
      const logs: Array<{ message: string; data?: object }> = []
      const ctrl = createUpdaterController({
        enabled: true,
        currentVersion: "1.0.0",
        backend: createMockBackend({
          checkForUpdates: async () => ({ isUpdateAvailable: false }),
        }),
        persistence: createMockPersistence(),
        stop: async () => {},
        log: (message, data) => logs.push({ message, data }),
      })
      await ctrl.check()
      expect(logs.length).toBeGreaterThan(0)
      expect(logs[0].message).toBe("updater state changed from=idle to=checking")
    })
  })
})
