import { mkdir } from "node:fs/promises"
import { withCdp } from "./cdp"

const directory = process.env.VIEWPORT_QA_DIRECTORY ?? "/private/tmp/opencode-viewport-qa"
const model = { providerID: "axonhub-codex", modelID: "gpt-5.6-sol" }
const timeoutMs = Number(process.env.VIEWPORT_QA_TIMEOUT_MS ?? 120_000)
const scenario = process.env.VIEWPORT_QA_SCENARIO === "tool" ? "tool" : "text"
const departureDeltaY = -18.75
const returnDeltaY = 23.5

type Snapshot = {
  at: number
  href: string
  sessionID?: string
  activeRoute?: string
  rootSessionID?: string
  ownerSessionKey?: string
  mounted: boolean
  top?: number
  height?: number
  client?: number
  gap?: number
  textLength: number
  viewportIntent?: string
  viewportGeneration?: string
  latestVisible: boolean
}

type BackendMessage = {
  info?: {
    id?: string
    parentID?: string
    role?: string
    finish?: string
    error?: string
    time?: { completed?: number }
  }
  parts?: Array<{ type?: string; text?: string; state?: { status?: string; output?: string } }>
}

type BackendState = {
  status?: string
  messages: BackendMessage[]
  assistantIDs: string[]
  userIDs: string[]
  textLength: number
  completedAssistantIDs: string[]
  toolStates: string[]
  toolOutputs: string[]
}

const sleep = (ms: number) => Bun.sleep(ms)

function encodeDirectory(value: string) {
  return Buffer.from(value).toString("base64url")
}

function assistantTextLength(message: BackendMessage | undefined) {
  return (
    message?.parts?.filter((part) => part.type === "text").reduce((sum, part) => sum + (part.text?.length ?? 0), 0) ?? 0
  )
}

async function main() {
  await mkdir(directory, { recursive: true })
  let exitCode = 0
  await withCdp(async (cdp, target) => {
    const origin = new URL(target.url).origin
    const init = await cdp.evaluate<{ url: string; username: string; password: string }>(
      "window.api.awaitInitialization((state) => ({ url: state.url, username: state.username, password: state.password }))",
    )
    const request = async <T>(path: string, body?: unknown) => {
      const response = await fetch(
        `${init.url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${Buffer.from(`${init.username}:${init.password}`).toString("base64")}`,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      )
      const text = await response.text()
      if (!response.ok) throw new Error(`request ${path} failed: ${response.status} ${text.slice(0, 300)}`)
      return (text ? JSON.parse(text) : undefined) as T
    }

    const created = await request<{ id: string }>("/session", {
      title: `Viewport QA baseline ${new Date().toISOString()}`,
    })
    const sessionID = created.id
    const sessionURL = `${origin}/${encodeDirectory(directory)}/session/${sessionID}`
    const sessionPath = new URL(sessionURL).pathname
    const navigation = await cdp.evaluate<{ browserHref: string }>(`(() => {
      const before = location.href;
      void import(${JSON.stringify(`${origin}/@fs/Users/lelouch/apps/opencode/packages/app/src/utils/notification-click.ts`)}).then((module) => module.handleNotificationClick(${JSON.stringify(sessionPath)})).catch((error) => console.error("viewport QA navigation failed", String(error)));
      return { browserHref: before };
    })()`)
    if (navigation.browserHref !== target.url)
      throw new Error("unexpected browser target change during memory-router navigation")

    await cdp.evaluate(`(() => {
      const state = window.__viewportQAFrame ??= { active: false, segments: [] };
      state.stop?.();
      state.segments = [];
      state.start = (name) => {
        state.stop?.();
        state.active = true;
        const segment = { name, samples: [] };
        state.current = segment;
        const sample = () => {
          if (!state.active || state.current !== segment) return;
        const root = [...document.querySelectorAll("[data-component=message-timeline] [data-slot=scroll-view-viewport]")].find((item) => item.getBoundingClientRect().height > 0);
        const timeline = root?.closest("[data-component=message-timeline]");
        const latest = document.querySelector("[data-component=composer-scroll-to-latest]");
        const style = latest ? getComputedStyle(latest) : undefined;
        const rect = latest?.getBoundingClientRect();
        const activeRoute = localStorage.getItem("opencode.desktop.last-active-url") ?? undefined;
        const parts = [...document.querySelectorAll("[data-component=text-part]")];
        segment.samples.push({
          at: performance.now(), activeRoute,
          rootSessionID: timeline?.getAttribute("data-session-id") ?? undefined,
          ownerSessionKey: timeline?.getAttribute("data-owner-session-key") ?? undefined,
          viewportIntent: timeline?.getAttribute("data-viewport-intent") ?? root?.getAttribute("data-viewport-intent") ?? undefined,
          viewportGeneration: timeline?.getAttribute("data-viewport-generation") ?? root?.getAttribute("data-viewport-generation") ?? undefined,
          latestVisible: Boolean(latest && style && rect && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0),
          top: root?.scrollTop,
          clientHeight: root?.clientHeight,
          gap: root ? root.scrollHeight - root.clientHeight - root.scrollTop : undefined,
          height: root?.scrollHeight,
          textLength: parts.reduce((total, item) => total + (item.textContent?.length ?? 0), 0),
        });
        if (segment.samples.length > 24000) segment.samples.shift();
          state.raf = requestAnimationFrame(sample);
        };
        state.raf = requestAnimationFrame(sample);
      };
      state.stop = () => {
        state.active = false;
        if (state.raf !== undefined) cancelAnimationFrame(state.raf);
        state.raf = undefined;
        if (state.current) state.segments.push(state.current);
        state.current = undefined;
      };
    })()`)

    await cdp.evaluate(`(() => {
      const state = window.__viewportInputTrace ??= { active: false, phase: "setup", expected: [], issued: [], unexpected: [] };
      state.active = false;
      state.phase = "setup";
      state.expected = [];
      state.issued = [];
      state.unexpected = [];
      state.startPhase = (phase) => { state.active = true; state.phase = phase; };
      state.expectWheel = (deltaY) => {
        const item = { phase: state.phase, deltaY, at: performance.now() };
        state.expected.push(item);
        state.issued.push(item);
        if (state.issued.length > 3000) state.issued.shift();
      };
      state.stop = () => { state.active = false; state.expected = []; };
      const onWheel = (event) => {
        if (!state.active) return;
        const target = event.target instanceof Element ? event.target.closest("[data-component=message-timeline]") : undefined;
        if (!target) return;
        const now = performance.now();
        state.expected = state.expected.filter((item) => now - item.at < 1000);
        const index = state.expected.findIndex((item) => Math.abs(item.deltaY - event.deltaY) <= 1.5);
        if (index >= 0) state.expected.splice(index, 1);
        else {
          state.unexpected.push({ phase: state.phase, type: "wheel", deltaY: event.deltaY, at: now, trusted: event.isTrusted });
          if (state.unexpected.length > 100) state.unexpected.shift();
        }
      };
      const onOther = (event) => {
        if (!state.active) return;
        const target = event.target instanceof Element ? event.target.closest("[data-component=message-timeline]") : undefined;
        if (!target) return;
        state.unexpected.push({ phase: state.phase, type: event.type, at: performance.now(), trusted: event.isTrusted });
        if (state.unexpected.length > 100) state.unexpected.shift();
      };
      window.addEventListener("wheel", onWheel, true);
      for (const type of ["touchstart", "touchmove", "keydown", "pointerdown", "click"]) window.addEventListener(type, onOther, true);
      state.cleanup = () => {
        window.removeEventListener("wheel", onWheel, true);
        for (const type of ["touchstart", "touchmove", "keydown", "pointerdown", "click"]) window.removeEventListener(type, onOther, true);
        state.stop();
      };
    })()`)

    try {
      const deadline = Date.now() + timeoutMs
      const snapshots: Snapshot[] = []
      const backendStates: Array<BackendState & { at: number }> = []
      const snapshot = async (): Promise<Snapshot> =>
        cdp.evaluate<Snapshot>(`(() => {
        const root = [...document.querySelectorAll("[data-component=message-timeline] [data-slot=scroll-view-viewport]")]
          .find((item) => item.getBoundingClientRect().height > 0);
        const timeline = root?.closest("[data-component=message-timeline]");
        const latest = document.querySelector("[data-component=composer-scroll-to-latest]");
        const latestStyle = latest ? getComputedStyle(latest) : undefined;
        const latestRect = latest?.getBoundingClientRect();
        const parts = [...document.querySelectorAll("[data-component=text-part]")];
        const textLength = parts.reduce((total, item) => total + (item.textContent?.length ?? 0), 0);
        const activeRoute = localStorage.getItem("opencode.desktop.last-active-url") ?? undefined;
        return {
          at: performance.now(), href: location.href, activeRoute,
          sessionID: activeRoute?.split("/session/")[1]?.split("/")[0],
          rootSessionID: timeline?.getAttribute("data-session-id") ?? undefined,
          ownerSessionKey: timeline?.getAttribute("data-owner-session-key") ?? undefined,
          viewportIntent: timeline?.getAttribute("data-viewport-intent") ?? root?.getAttribute("data-viewport-intent") ?? undefined,
          viewportGeneration: timeline?.getAttribute("data-viewport-generation") ?? root?.getAttribute("data-viewport-generation") ?? undefined,
          latestVisible: Boolean(latest && latestStyle && latestRect && latestStyle.display !== "none" && latestStyle.visibility !== "hidden" && latestRect.width > 0 && latestRect.height > 0),
          mounted: Boolean(root && timeline), top: root?.scrollTop, height: root?.scrollHeight,
          client: root?.clientHeight, gap: root ? root.scrollHeight - root.clientHeight - root.scrollTop : undefined,
          textLength,
        };
      })()`)
      const backend = async (): Promise<BackendState> => {
        const [statuses, messages] = await Promise.all([
          request<Record<string, { type?: string }>>("/session/status"),
          request<BackendMessage[]>(`/session/${sessionID}/message`),
        ])
        const assistant = messages.filter((message) => message.info?.role === "assistant")
        return {
          status: statuses[sessionID]?.type ?? "idle",
          messages,
          assistantIDs: assistant.map((message) => message.info?.id).filter((id): id is string => Boolean(id)),
          userIDs: messages
            .map((message) => (message.info?.role === "user" ? message.info?.id : undefined))
            .filter((id): id is string => Boolean(id)),
          textLength: assistant.reduce((sum, message) => sum + assistantTextLength(message), 0),
          completedAssistantIDs: assistant
            .filter((message) => message.info?.time?.completed)
            .map((message) => message.info?.id)
            .filter((id): id is string => Boolean(id)),
          toolStates: messages.flatMap(
            (message) =>
              message.parts
                ?.filter((part) => part.type?.startsWith("tool"))
                .map((part) => part.state?.status ?? "unknown") ?? [],
          ),
          toolOutputs: messages.flatMap(
            (message) =>
              message.parts?.filter((part) => part.type?.startsWith("tool")).map((part) => part.state?.output ?? "") ??
              [],
          ),
        }
      }
      const currentSnapshot = async () => {
        const next = await snapshot()
        const unexpected = await cdp.evaluate<Array<{ phase: string; type: string; deltaY?: number }>>("(window.__viewportInputTrace?.unexpected ?? []).slice(-3)")
        if (unexpected.length > 0) throw new Error(`input contaminated during ${unexpected[0]!.phase}: ${JSON.stringify(unexpected[0])}`)
        if (
          !next.mounted ||
          next.sessionID !== sessionID ||
          next.rootSessionID !== sessionID ||
          !next.ownerSessionKey?.endsWith(`/${sessionID}`)
        ) {
          throw new Error(
            `dedicated session root lost: expected=${sessionID} route=${next.sessionID ?? "none"} root=${next.rootSessionID ?? "none"} owner=${next.ownerSessionKey ?? "none"}`,
          )
        }
        return next
      }
      const expectWheel = (deltaY: number) => cdp.evaluate(`window.__viewportInputTrace?.expectWheel?.(${String(deltaY)})`)
      const record = async () => {
        const next = await currentSnapshot()
        snapshots.push(next)
        if (snapshots.length > 600) snapshots.shift()
        const state = await backend()
        backendStates.push({ at: Date.now(), ...state })
        if (backendStates.length > 300) backendStates.shift()
        return { next, state }
      }
      const waitForMountedRoot = async () => {
        for (let i = 0; i < 120 && Date.now() < deadline; i++) {
          const next = await snapshot()
          if (next.sessionID && next.sessionID !== sessionID && next.rootSessionID === sessionID) {
            throw new Error(
              `dedicated session route changed during setup: expected=${sessionID} route=${next.sessionID}`,
            )
          }
          if (next.mounted && next.sessionID === sessionID && next.rootSessionID === sessionID) return next
          await sleep(250)
        }
        throw new Error("dedicated session root was not mounted with the expected session identity")
      }
      const prompt = (text: string) =>
        request(`/session/${sessionID}/prompt_async`, { model, agent: "build", parts: [{ type: "text", text }] })
      const baselineState = await backend()
      const baselineAssistantIDs = new Set(baselineState.assistantIDs)
    await waitForMountedRoot()

      await prompt(
        "UI baseline seed. Return exactly 40 short numbered lines about a fictional observatory. Do not use tools.",
      )
      let seedReceipt: BackendState | undefined
      for (let i = 0; i < 180 && Date.now() < deadline; i++) {
        const state = await backend()
        const received = state.messages.find(
          (message) =>
            message.info?.role === "assistant" && message.info.id && !baselineAssistantIDs.has(message.info.id),
        )
        if (
          received &&
          state.status === "idle" &&
          state.completedAssistantIDs.includes(received.info?.id ?? "") &&
          assistantTextLength(received) > 200
        ) {
          seedReceipt = state
          break
        }
        await sleep(250)
      }
      if (!seedReceipt) throw new Error("seed receipt incomplete; refusing to send overlapping stream prompt")

      const seedUserIDs = new Set(seedReceipt.userIDs)
      const seedAssistantIDs = new Set(seedReceipt.assistantIDs)
      const seedGeometry = await currentSnapshot()
      const seedOverflow = (seedGeometry.height ?? 0) - (seedGeometry.client ?? 0) > 250
      if (!seedOverflow) throw new Error("seed did not establish enough real overflow for upward departure")
      const streamPrompt =
        scenario === "tool"
          ? "UI baseline tool scenario. Use the shell tool only with safe commands: first run printf 'TOOL_PHASE_A_%02d\\n' 1 2 3 4 5, then run sleep 2; printf 'TOOL_PHASE_B_%02d\\n' 1 2 3 4 5, then return 100 short numbered lines about a fictional coastal archive. Do not create or modify files. Emit the final lines progressively and finish."
          : "UI baseline stream. Return exactly 100 short numbered lines about a fictional coastal archive. Do not use tools. Emit the lines progressively and finish."
      await prompt(streamPrompt)
      let streamUserID: string | undefined
      let streamAssistantID: string | undefined
      let wheelStarted = false
      let upwardMoved = false
      let upwardTopMoved = false
      let upwardReading = false
      let downMoved = false
      let bottomReached = false
      let zeroMotionObserved = false
      let upwardLatestVisible = false
      let returnButtonHidden = false
      let idleAwayButtonVisible = false
      let idleReturnButtonHidden = false
      const postReturnGrowth: Snapshot[] = []
      const postReturnSamples: Snapshot[] = []
      let lastTailMetric = -1
      let lastTextLength = -1
      let returnedAt = -1
      let followGeneration: string | undefined
      let finalState: BackendState | undefined

      for (let i = 0; i < 480 && Date.now() < deadline; i++) {
        const { next, state } = await record()
        const newUser = state.messages.find(
          (message) => message.info?.role === "user" && message.info.id && !seedUserIDs.has(message.info.id),
        )
        streamUserID ||= newUser?.info?.id
        const newAssistants = state.messages.filter(
          (message) =>
            message.info?.role === "assistant" &&
            message.info.id &&
            message.info.parentID === streamUserID &&
            !baselineAssistantIDs.has(message.info.id) &&
            !seedAssistantIDs.has(message.info.id),
        )
        const newAssistant = newAssistants.at(-1)
        if (newAssistant?.info?.id && (assistantTextLength(newAssistant) > 0 || !streamAssistantID))
          streamAssistantID = newAssistant.info.id
        if (
          !wheelStarted &&
          streamAssistantID &&
          next.mounted &&
          next.height !== undefined &&
          next.client !== undefined &&
          next.height - next.client > 250
        ) {
          wheelStarted = true
          const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
          const root = [...document.querySelectorAll("[data-component=message-timeline] [data-slot=scroll-view-viewport]")].find((item) => item.getBoundingClientRect().height > 0)?.getBoundingClientRect();
          return root ? { x: root.right - 30, y: root.top + root.height / 2 } : { x: 10, y: 10 };
        })()`)
          const hit = await cdp.evaluate<{ rootContains: boolean; component?: string; tag?: string }>(`(() => {
            const root = [...document.querySelectorAll("[data-component=message-timeline] [data-slot=scroll-view-viewport]")].find((item) => item.getBoundingClientRect().height > 0);
            const hit = document.elementFromPoint(${point.x}, ${point.y});
            return { rootContains: Boolean(root && hit && root.contains(hit)), component: hit?.getAttribute("data-component") ?? undefined, tag: hit?.tagName };
          })()`)
          if (!hit.rootContains) throw new Error(`wheel hit-test failed: ${JSON.stringify(hit)}`)
          await currentSnapshot()
          await cdp.evaluate('window.__viewportInputTrace?.startPhase?.("trajectory")')
          await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
          const beforeUp = next.gap ?? 0
          for (let index = 0; index < 48; index++) {
            await currentSnapshot()
            await expectWheel(departureDeltaY)
            await cdp.call("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              ...point,
              deltaX: 0,
              deltaY: departureDeltaY,
            })
            const after = await currentSnapshot()
            if ((after.gap ?? 0) > beforeUp + 4) upwardMoved = true
            if ((after.top ?? 0) < (next.top ?? 0) - 1) upwardTopMoved = true
            if (after.viewportIntent === "reading") upwardReading = true
            if ((after.gap ?? 0) > 4 && after.latestVisible) upwardLatestVisible = true
            await sleep(4)
          }
          const downStartGap = (await currentSnapshot()).gap ?? 0
          const returnDeadline = Math.min(deadline, Date.now() + 30_000)
          for (let index = 0; Date.now() < returnDeadline; index++) {
            await currentSnapshot()
            await expectWheel(returnDeltaY)
            await cdp.call("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              ...point,
              deltaX: 0,
              deltaY: returnDeltaY,
            })
            const after = await currentSnapshot()
            if ((after.gap ?? 0) < downStartGap - 4) downMoved = true
            if ((after.gap ?? Number.POSITIVE_INFINITY) <= 1) {
              bottomReached = true
              const returned = await currentSnapshot()
              snapshots.push(returned)
              returnedAt = snapshots.length
              lastTextLength = returned.textLength
              lastTailMetric = returned.height ?? 0
              followGeneration = returned.viewportGeneration
              returnButtonHidden = !returned.latestVisible
              await cdp.evaluate('window.__viewportInputTrace?.startPhase?.("main-follow")')
              await cdp.evaluate("window.__viewportQAFrame?.start?.(\"main-follow\")")
              break
            }
            await sleep(4)
          }
          for (let index = 0; index < 24; index++) {
            const before = await currentSnapshot()
            await currentSnapshot()
            await expectWheel(returnDeltaY)
            await cdp.call("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              ...point,
              deltaX: 0,
              deltaY: returnDeltaY,
            })
            const after = await currentSnapshot()
            if (Math.abs((after.top ?? 0) - (before.top ?? 0)) < 0.05) zeroMotionObserved = true
            await sleep(4)
          }
        }
        if (returnedAt >= 0 && snapshots.length > returnedAt) postReturnSamples.push(next)
        if (
          returnedAt >= 0 &&
          snapshots.length > returnedAt &&
          (next.textLength > lastTextLength || (next.height ?? 0) > lastTailMetric)
        ) {
          postReturnGrowth.push(next)
          followGeneration ||= next.viewportGeneration
        }
        lastTextLength = Math.max(lastTextLength, next.textLength)
        lastTailMetric = Math.max(lastTailMetric, next.height ?? 0)
        finalState = state
        if (
          wheelStarted &&
          streamAssistantID &&
          state.status === "idle" &&
          state.completedAssistantIDs.includes(streamAssistantID)
        )
          break
        await sleep(200)
      }
      for (let i = 0; i < 12 && Date.now() < deadline; i++) {
        const { next } = await record()
        if (returnedAt >= 0 && snapshots.length > returnedAt) postReturnSamples.push(next)
        await sleep(200)
      }
      finalState ||= await backend()
      const streamReceipt = finalState.messages.find((message) => message.info?.id === streamAssistantID)
      const stableTail = snapshots
        .slice(-5)
        .every((item) => item.mounted && (item.gap ?? Number.POSITIVE_INFINITY) <= 1)
      const finalGeometryStable = snapshots
        .slice(-3)
        .every((item, index, values) => index === 0 || item.height === values[index - 1]?.height)
      const followIntentDuringGrowth =
        postReturnGrowth.length >= 3 &&
        postReturnGrowth.every((item) => item.viewportIntent === "live" || item.viewportIntent === "following")
      const generationStableDuringGrowth =
        postReturnGrowth.length >= 3 && postReturnGrowth.every((item) => item.viewportGeneration === followGeneration)
      const idleReturn = { attempted: false, upwardMoved: false, bottomReached: false, stable: false }
      if (finalState.status === "idle" && streamReceipt?.info?.time?.completed) {
        idleReturn.attempted = true
        await cdp.evaluate("window.__viewportQAFrame?.stop?.()")
        await cdp.evaluate('window.__viewportInputTrace?.startPhase?.("idle-departure")')
        const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
        const root = [...document.querySelectorAll("[data-component=message-timeline] [data-slot=scroll-view-viewport]")].find((item) => item.getBoundingClientRect().height > 0)?.getBoundingClientRect();
        return root ? { x: root.right - 30, y: root.top + root.height / 2 } : { x: 10, y: 10 };
      })()`)
        await currentSnapshot()
        for (let index = 0; index < 48; index++) {
          await currentSnapshot()
          await expectWheel(departureDeltaY)
          await cdp.call("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            ...point,
            deltaX: 0,
            deltaY: departureDeltaY,
          })
          const after = await currentSnapshot()
          if ((after.gap ?? 0) > 4 && after.latestVisible) idleAwayButtonVisible = true
          await sleep(4)
        }
        idleReturn.upwardMoved = (await currentSnapshot()).gap! > 4
        const idleReturnDeadline = Math.min(deadline, Date.now() + 30_000)
        for (let index = 0; Date.now() < idleReturnDeadline; index++) {
          await currentSnapshot()
          await expectWheel(returnDeltaY)
          await cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: returnDeltaY })
          const after = await currentSnapshot()
          if ((after.gap ?? Number.POSITIVE_INFINITY) <= 1 && !after.latestVisible) idleReturnButtonHidden = true
          if ((after.gap ?? Number.POSITIVE_INFINITY) <= 1) {
            idleReturn.bottomReached = true
            await cdp.evaluate('window.__viewportInputTrace?.startPhase?.("idle-follow")')
            await cdp.evaluate('window.__viewportQAFrame?.start?.("idle-follow")')
            break
          }
          await sleep(4)
        }
        for (let index = 0; index < 6; index++) {
          await sleep(200)
          snapshots.push(await currentSnapshot())
        }
        idleReturn.stable = snapshots.slice(-5).every((item) => (item.gap ?? Number.POSITIVE_INFINITY) <= 1)
      }

      await cdp.evaluate("window.__viewportQAFrame?.stop?.()")
      const frameSegments = await cdp.evaluate<
        Array<{
          name: string
          samples: Array<{
            at: number
            activeRoute?: string
            rootSessionID?: string
            ownerSessionKey?: string
            viewportIntent?: string
            viewportGeneration?: string
            latestVisible: boolean
            top?: number
            clientHeight?: number
            gap?: number
            height?: number
            textLength: number
          }>
        }>
      >("(window.__viewportQAFrame?.segments ?? []).slice(-4)")
      const mainFrameSamples = frameSegments.find((segment) => segment.name === "main-follow")?.samples ?? []
      const idleFrameSamples = frameSegments.find((segment) => segment.name === "idle-follow")?.samples ?? []
      const frameSamples = [...mainFrameSamples, ...idleFrameSamples]
      const frameFollowSamples = frameSamples
      const frameGrowthSamples = frameFollowSamples.filter(
        (sample, index, values) =>
          index > 0 &&
          (sample.textLength > values[index - 1]!.textLength ||
            (sample.height ?? 0) > (values[index - 1]!.height ?? 0)),
      )
      const frameMovement = (samples: Array<{ top?: number; gap?: number }>) => {
        let stall = 0
        let maxStall = 0
        let maxGap = 0
        for (let index = 1; index < samples.length; index++) {
          const current = samples[index]!
          const previous = samples[index - 1]!
          maxGap = Math.max(maxGap, current.gap ?? 0)
          if ((current.gap ?? 0) > 1 && Math.abs((current.top ?? 0) - (previous.top ?? 0)) < 0.05) stall++
          else {
            maxStall = Math.max(maxStall, stall)
            stall = 0
          }
        }
        maxStall = Math.max(maxStall, stall)
        return { maxStall, maxGap }
      }
      const mainMovement = frameMovement(mainFrameSamples)
      const idleMovement = frameMovement(idleFrameSamples)
      const frameMovementDuringFollow = Math.max(mainMovement.maxStall, idleMovement.maxStall) < 8
      const inputTrace = await cdp.evaluate<{ phase: string; issued: Array<{ phase: string; deltaY: number; at: number }>; unexpected: Array<{ phase: string; type: string; deltaY?: number; at: number; trusted: boolean }> }>("({ phase: window.__viewportInputTrace?.phase ?? \"unknown\", issued: (window.__viewportInputTrace?.issued ?? []).slice(-300), unexpected: (window.__viewportInputTrace?.unexpected ?? []).slice(-30) })")
      const frameIdentity =
        frameFollowSamples.length > 0 &&
        frameFollowSamples.every(
          (sample) =>
            sample.rootSessionID === sessionID &&
            sample.ownerSessionKey?.endsWith(`/${sessionID}`) &&
            sample.activeRoute?.endsWith(`/session/${sessionID}`),
        )
      const frameOwnerFollowing =
        frameIdentity &&
        frameFollowSamples.every((sample) => sample.viewportIntent === "live" || sample.viewportIntent === "following")
      const frameButtonHidden = frameIdentity && frameFollowSamples.every((sample) => !sample.latestVisible)
      const frameGrowthButtonHidden =
        frameIdentity && frameGrowthSamples.length >= 3 && frameGrowthSamples.every((sample) => !sample.latestVisible)
      const frameIdentityViolations = frameFollowSamples.filter((sample) => sample.rootSessionID !== sessionID || !sample.ownerSessionKey?.endsWith(`/${sessionID}`) || !sample.activeRoute?.endsWith(`/session/${sessionID}`)).length
      const frameOwnerViolations = frameFollowSamples.filter((sample) => sample.viewportIntent !== "live" && sample.viewportIntent !== "following").length
      const frameButtonViolations = frameFollowSamples.filter((sample) => sample.latestVisible).length
      const checks = {
        mountedCorrectSession: snapshots.some(
          (item) =>
            item.mounted &&
            item.sessionID === sessionID &&
            item.rootSessionID === sessionID &&
            item.ownerSessionKey?.endsWith(`/${sessionID}`),
        ),
        seedOverflow,
        toolOutputReceipt:
          scenario === "tool"
            ? finalState.toolStates.some((state) => state === "completed" || state === "success") &&
              finalState.toolOutputs.some((output) => output.includes("TOOL_PHASE_A_01")) &&
              finalState.toolOutputs.some((output) => output.includes("TOOL_PHASE_B_05"))
            : true,
        seedReceipt: Boolean(seedReceipt),
        streamReceipt: Boolean(
          streamUserID &&
            streamAssistantID &&
            streamReceipt?.info?.time?.completed &&
            assistantTextLength(streamReceipt) > 500,
        ),
        streamIdle: finalState.status === "idle",
        wheelStarted,
        upwardMoved,
        upwardTopMoved,
        upwardReading,
        downMoved,
        bottomReached,
        zeroMotionObserved,
        upwardLatestVisible,
        returnButtonHidden,
        ownerFollowingAfterReturn:
          postReturnSamples.length > 0 &&
          postReturnSamples.every((item) => item.viewportIntent === "live" || item.viewportIntent === "following"),
        buttonHiddenAfterReturn: postReturnSamples.length > 0 && postReturnSamples.every((item) => !item.latestVisible),
        growthButtonHidden: postReturnGrowth.length >= 3 && postReturnGrowth.every((item) => !item.latestVisible),
        frameOwnerFollowing,
        frameIdentity,
        frameButtonHidden,
        frameGrowthButtonHidden,
        frameMovementDuringFollow,
        inputTraceClean: inputTrace.unexpected.length === 0,
        followIntentDuringGrowth,
        generationStableDuringGrowth,
        finalGeometryStable,
        stableTail,
        idleAwayButtonVisible,
        idleReturn: idleReturn.attempted
          ? idleReturn.upwardMoved && idleReturn.bottomReached && idleReturn.stable && idleReturnButtonHidden
          : false,
      }
      const failed = Object.entries(checks)
        .filter(([, value]) => !value)
        .map(([key]) => key)
      const result = {
        runtime: {
          targetURL: target.url,
          rendererOrigin: origin,
          sidecarURL: init.url,
          directory,
          sessionID,
          scenario,
        },
        checks,
        failed,
        acceptance: failed.length === 0 ? "pass" : "incomplete",
        coverage: {
          sampleCount: snapshots.length,
          backendSampleCount: backendStates.length,
          postReturnGrowthCommits: postReturnGrowth.length,
          frameSamplesTotal: frameSamples.length,
          mainFrameSamples: mainFrameSamples.length,
          idleFrameSamples: idleFrameSamples.length,
          growthFrameCount: frameGrowthSamples.length,
          frameIdentityViolations,
          frameOwnerViolations,
          frameButtonViolations,
          finalStatus: finalState.status,
        },
        messages: {
          streamUserID,
          streamAssistantID,
          seedAssistantIDs: seedReceipt?.assistantIDs ?? [],
          toolStates: finalState.toolStates,
          toolOutputs: finalState.toolOutputs,
        },
        traces: snapshots.slice(-80),
        frameSamples: frameSamples.slice(-300),
        frameMovement: { main: mainMovement, idle: idleMovement },
        inputTrace,
        decisiveScrollTopWrites: "none: harness only reads scrollTop and dispatches CDP wheel events",
        physicalTrackpadTest: false,
      }
      console.log(JSON.stringify(result, null, 2))
      if (failed.length > 0) exitCode = 2
    } finally {
      await cdp.evaluate("window.__viewportQAFrame?.stop?.()")
      await cdp.evaluate("window.__viewportInputTrace?.cleanup?.()")
    }
  }, "http://127.0.0.1:9222")
  process.exitCode = exitCode
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
