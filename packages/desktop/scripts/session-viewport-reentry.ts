import { withCdp } from "./cdp"
import { fileURLToPath } from "node:url"

const sessionID = process.env.VIEWPORT_QA_SESSION_ID
const directory = process.env.VIEWPORT_QA_DIRECTORY
const baselineOtherRoute = process.env.VIEWPORT_QA_BASELINE_OTHER_ROUTE
const projectLabel = process.env.VIEWPORT_QA_PROJECT_LABEL
const marker = process.env.VIEWPORT_QA_MARKER
const configDelayMs = Number(process.env.QA_CONFIG_DELAY_MS ?? 300)

if (!sessionID || !directory || !baselineOtherRoute || !projectLabel || !marker) {
  throw new Error(
    "Set VIEWPORT_QA_SESSION_ID, VIEWPORT_QA_DIRECTORY, VIEWPORT_QA_BASELINE_OTHER_ROUTE, VIEWPORT_QA_PROJECT_LABEL, and VIEWPORT_QA_MARKER",
  )
}

const sleep = (ms: number) => Bun.sleep(ms)
const encodeDirectory = (value: string) => Buffer.from(value).toString("base64url")

type RootSnapshot = {
  href: string
  activeRoute?: string
  overlay: boolean
  timelines: Array<{ sessionID?: string; owner?: string; connected: boolean; rows: number }>
  current?: {
    sessionID?: string
    owner?: string
    intent?: string
    top: number
    height: number
    client: number
    gap: number
    markerVisible: boolean
  }
}

async function main() {
  await withCdp(async (cdp, target) => {
    const origin = new URL(target.url).origin
    const navigationModule = `${origin}/@fs${fileURLToPath(new URL("../../app/src/utils/notification-click.ts", import.meta.url))}`
    const targetRoute = `/${encodeDirectory(directory)}/session/${sessionID}`
    const targetOwnerSuffix = `/${sessionID}`
    const snapshots: Array<{ phase: string; state: RootSnapshot }> = []

    const navigateWithAppRouter = async (route: string) => {
      await cdp.evaluate(`(() => {
        const before = location.href;
        void import(${JSON.stringify(navigationModule)}).then((module) => module.handleNotificationClick(${JSON.stringify(route)})).catch((error) => console.error("reentry navigation failed", String(error)));
        return before;
      })()`)
    }

    const snapshot = async (): Promise<RootSnapshot> =>
      cdp.evaluate<RootSnapshot>(`(() => {
        const activeRoute = localStorage.getItem("opencode.desktop.last-active-url") ?? undefined;
        const visibleTimelines = [...document.querySelectorAll("[data-component=message-timeline]")].filter((item) => {
          const rect = item.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        const marker = ${JSON.stringify(marker)};
        const timelines = visibleTimelines.map((timeline) => ({
          sessionID: timeline.getAttribute("data-session-id") ?? undefined,
          owner: timeline.getAttribute("data-owner-session-key") ?? undefined,
          connected: timeline.isConnected,
          rows: timeline.querySelectorAll("[data-timeline-row]").length,
        }));
        const timeline = visibleTimelines.find((item) => item.getAttribute("data-session-id") === ${JSON.stringify(sessionID)});
        const root = timeline ? [...timeline.querySelectorAll("[data-slot=scroll-view-viewport]")].find((item) => item.getBoundingClientRect().height > 0) : undefined;
        const markerNode = marker && timeline ? timeline.querySelector("#message-" + marker) : undefined;
        const viewport = root?.getBoundingClientRect();
        const markerRect = markerNode?.getBoundingClientRect();
        return {
          href: location.href,
          activeRoute,
          overlay: Boolean(document.querySelector("[data-component=sidebar-dismiss-overlay]")),
          timelines,
          current: root && viewport ? {
            sessionID: timeline?.getAttribute("data-session-id") ?? undefined,
            owner: timeline?.getAttribute("data-owner-session-key") ?? undefined,
            intent: timeline?.getAttribute("data-viewport-intent") ?? root.getAttribute("data-viewport-intent") ?? undefined,
            top: root.scrollTop,
            height: root.scrollHeight,
            client: root.clientHeight,
            gap: root.scrollHeight - root.clientHeight - root.scrollTop,
            markerVisible: Boolean(markerRect && markerRect.bottom > viewport.top && markerRect.top < viewport.bottom),
          } : undefined,
        };
      })()`)

    const record = async (phase: string) => {
      const state = await snapshot()
      snapshots.push({ phase, state })
      return state
    }
    const waitForRoute = async (route: string, documentToken?: string) => {
      const expectedSession = route.match(/\/session\/([^/?#]+)/)?.[1]
      for (let i = 0; i < 120; i++) {
        const state = await snapshot()
        const ready = await cdp.evaluate<{ ready: boolean; session?: string; token?: string }>(`(() => ({
          ready: document.readyState === "complete",
          session: document.querySelector("[data-component=message-timeline]")?.getAttribute("data-session-id") ?? undefined,
          token: window.__reentryReloadToken,
        }))()`)
        if (
          state.activeRoute === route &&
          ready.ready &&
          (!expectedSession || ready.session === expectedSession) &&
          (!documentToken || ready.token !== documentToken)
        )
          return state
        await sleep(100)
      }
      throw new Error(`route did not settle: ${route}`)
    }
    const assertTarget = (state: RootSnapshot, phase: string) => {
      const current = state.current
      if (!current || current.sessionID !== sessionID || !current.owner?.endsWith(targetOwnerSuffix)) {
        throw new Error(
          `target identity lost phase=${phase} session=${current?.sessionID ?? "none"} owner=${current?.owner ?? "none"}`,
        )
      }
    }
    const pointForRoot = async (allowOverlay = false) => {
      const result = await cdp.evaluate<{ x: number; y: number; contains: boolean; hit?: string }>(`(() => {
        const timeline = [...document.querySelectorAll("[data-component=message-timeline]")].find((item) => item.getAttribute("data-session-id") === ${JSON.stringify(sessionID)});
        const root = timeline ? [...timeline.querySelectorAll("[data-slot=scroll-view-viewport]")].find((item) => item.getBoundingClientRect().height > 0) : undefined;
        if (!root) return { x: 0, y: 0, contains: false, hit: "none" };
        const rect = root.getBoundingClientRect();
        const x = rect.right - 30;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, contains: Boolean(hit && root.contains(hit)), hit: hit?.getAttribute("data-component") ?? hit?.tagName };
      })()`)
      if (!result.contains && !allowOverlay) throw new Error(`wheel hit-test failed hit=${result.hit ?? "none"}`)
      return result
    }
    const nativeClick = async (x: number, y: number) => {
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
    }
    const clickSelector = async (selector: string) => {
      const rect = await cdp.evaluate<{ x: number; y: number } | undefined>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const rect = el?.getBoundingClientRect();
        return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : undefined;
      })()`)
      if (!rect) throw new Error(`selector not found: ${selector}`)
      await nativeClick(rect.x, rect.y)
    }

    try {
      await navigateWithAppRouter(baselineOtherRoute)
      await waitForRoute(baselineOtherRoute)
      const reloadToken = `reentry-${Date.now()}`
      await cdp.evaluate(`window.__reentryReloadToken=${JSON.stringify(reloadToken)}`)
      await cdp.call("Page.reload", { ignoreCache: false })
      await waitForRoute(baselineOtherRoute, reloadToken)
      const homeRoute = "/"
      await navigateWithAppRouter(homeRoute)
      await waitForRoute(homeRoute)
      await cdp.evaluate(`(() => {
      const state = window.__reentryLogs ??= { logs: [], cleanup: undefined, delayed: 0 };
      state.logs = [];
      for (const level of ["debug", "warn"]) {
        const original = console[level].bind(console);
        state[level] = original;
        console[level] = (...args) => {
          const text = args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ");
          if (/scroll-root-bind|root-mismatch|timeline.*(mount|unmount)|prefetch|message.*commit/i.test(text)) {
            state.logs.push(text.slice(0, 700));
            if (state.logs.length > 200) state.logs.shift();
          }
          original(...args);
        };
      }
      state.cleanup = () => {
        if (state.debug) console.debug = state.debug;
        if (state.warn) console.warn = state.warn;
        state.cleanup = undefined;
      };
    })()`)
      if (configDelayMs > 0) {
        await cdp.evaluate(`(() => {
        const state = window.__reentryLogs;
        const original = window.fetch;
        state.fetch = original;
        window.fetch = async (...args) => {
          const request = new Request(args[0], args[1]);
          const url = new URL(request.url);
          const scope = url.searchParams.get("directory") ?? request.headers.get("x-opencode-directory");
          const response = await original(...args);
          if (request.method === "GET" && url.pathname === "/config" && scope && (scope === ${JSON.stringify(directory)} || decodeURIComponent(scope) === ${JSON.stringify(directory)})) {
            state.delayed++;
            console.debug("[reentry] config-response-delayed ms=${configDelayMs}");
            await new Promise(resolve => setTimeout(resolve, ${String(configDelayMs)}));
          }
          return response;
        };
      })()`)
      }
      await clickSelector(`[data-action="project-switch"][aria-label=${JSON.stringify(projectLabel)}]`)
      await sleep(300)
      const sessionLink = `[data-component="sidebar-session"][data-session-id=${JSON.stringify(sessionID)}] a`
      let linkRect: { x: number; y: number } | undefined
      for (let attempt = 0; attempt < 100 && !linkRect; attempt++) {
        linkRect = await cdp.evaluate<{ x: number; y: number } | undefined>(`(() => {
      const el = document.querySelector(${JSON.stringify(sessionLink)});
      const rect = el?.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : undefined;
    })()`)
        if (!linkRect) await sleep(100)
      }
      if (!linkRect) throw new Error(`sidebar session link not found for ${sessionID}`)
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: linkRect.x, y: linkRect.y })
      await sleep(20)
      await nativeClick(linkRect.x, linkRect.y)
      await waitForRoute(targetRoute)
      for (let i = 0; i < 80; i++) {
        const state = await record("target-mount")
        if (state.current?.sessionID === sessionID && state.current.owner?.endsWith(targetOwnerSuffix)) break
        await sleep(100)
      }

      let state = await record("before-overlay")
      if (state.overlay) {
        const point = await pointForRoot(true)
        await nativeClick(point.x, point.y)
        await sleep(250)
        state = await record("after-overlay")
      }
      const point = await pointForRoot()
      const before = state.current!
      let markerSeen = before.markerVisible
      for (let i = 0; i < 12 && !markerSeen; i++) {
        const expected = -160
        await cdp.call("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: point.x,
          y: point.y,
          deltaX: 0,
          deltaY: expected,
        })
        await sleep(30)
        state = await record("upward")
        assertTarget(state, "upward")
        markerSeen = Boolean(state.current?.markerVisible)
      }
      if (!markerSeen) throw new Error("marker did not become visible during bounded upward scroll")
      const afterUp = state.current!
      if (!(afterUp.intent === "reading" && afterUp.top < before.top))
        throw new Error(
          `upward ownership proof failed before=${before.top} after=${afterUp.top} intent=${afterUp.intent}`,
        )
      await sleep(500)
      const stable = await record("upward-stable")
      if (stable.current?.intent !== "reading")
        throw new Error(`reading intent changed before reentry: ${stable.current?.intent}`)
      const beforeReturn = stable.current!
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: 12 })
      await sleep(500)
      const afterReturn = await record("positive-12")
      assertTarget(afterReturn, "positive-12")
      const delta = afterReturn.current!.top - beforeReturn.top
      if (Math.abs(delta - 12) > 6 || afterReturn.current!.intent !== "reading" || afterReturn.current!.gap < 20) {
        throw new Error(
          `positive-12 reentry failed delta=${delta} intent=${afterReturn.current!.intent} gap=${afterReturn.current!.gap}`,
        )
      }
      const returnDeadline = Date.now() + 15_000
      let liveTail: RootSnapshot | undefined
      while (Date.now() < returnDeadline) {
        await cdp.call("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: point.x,
          y: point.y,
          deltaX: 0,
          deltaY: 160,
        })
        await sleep(30)
        const current = await record("natural-return")
        assertTarget(current, "natural-return")
        if ((current.current?.gap ?? Infinity) <= 1) {
          liveTail = current
          break
        }
      }
      if (!liveTail || !["live", "following"].includes(liveTail.current?.intent ?? ""))
        throw new Error("natural return did not recover live tail")

      const logs = await cdp.evaluate<{ logs: string[]; delayed: number }>(
        "({ logs: (window.__reentryLogs?.logs ?? []).slice(-100), delayed: window.__reentryLogs?.delayed ?? 0 })",
      )
      const targetBindCount = logs.logs.filter(
        (line) => line.includes(sessionID) && line.includes("scroll-root-bind"),
      ).length
      const invalidTargetLogs = logs.logs.filter(
        (line) =>
          /mount session=none/.test(line) ||
          (line.includes(sessionID) && /root-mismatch|nextConnected=false/.test(line)),
      )
      if (configDelayMs > 0 && logs.delayed === 0) throw new Error("configured /config delay did not trigger")
      if (targetBindCount !== 1) throw new Error(`expected exactly one target bind, observed=${targetBindCount}`)
      if (invalidTargetLogs.length > 0) throw new Error(`invalid target lifecycle logs: ${invalidTargetLogs[0]}`)
      console.log(
        JSON.stringify(
          {
            runtime: { targetURL: target.url, origin, sessionID, directory, marker },
            before,
            afterUp,
            positive12: { before: beforeReturn, after: afterReturn, delta },
            liveTail,
            timelineSnapshots: snapshots.slice(-80),
            logs,
            checks: {
              mounted: true,
              markerSeen,
              upwardReading: afterUp.intent === "reading",
              positive12Reading: afterReturn.current?.intent === "reading",
              positive12Delta: Math.abs(delta - 12) <= 6,
              liveTailRecovered: Boolean(liveTail),
              configDelayTriggered: logs.delayed > 0,
              targetBindCount,
              invalidTargetLifecycle: invalidTargetLogs.length === 0,
            },
          },
          null,
          2,
        ),
      )
    } catch (error) {
      console.log(
        JSON.stringify(
          { error: String(error), snapshots, logs: await cdp.evaluate("window.__reentryLogs?.logs ?? []") },
          null,
          2,
        ),
      )
      throw error
    } finally {
      await cdp.evaluate(
        "window.__reentryLogs?.cleanup?.(); if (window.__reentryLogs?.fetch) window.fetch = window.__reentryLogs.fetch",
      )
    }
  })
}

await main()
