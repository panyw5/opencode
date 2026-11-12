const e = globalThis.__OPENCODE_EXTENSION_HOST__?.modules?.["solid-js/web"]
if (!e) throw new Error("OpenCode host module is unavailable: solid-js/web")
e.Aliases
e.Assets
e.ChildProperties
e.DOMElements
e.DelegatedEvents
e.Dynamic
e.ErrorBoundary
e.For
e.Hydration
e.HydrationScript
e.Index
e.Match
e.NoHydration
e.Portal
e.Properties
e.RequestContext
e.SVGElements
e.SVGNamespace
e.Show
e.Suspense
e.SuspenseList
e.Switch
e.addEventListener
e.assign
e.classList
e.className
e.clearDelegatedEvents
const a = e.createComponent
e.createDynamic
e.delegateEvents
e.dynamicProperty
const q = e.effect
e.escape
e.generateHydrationScript
e.getAssets
e.getHydrationKey
e.getNextElement
e.getNextMarker
e.getNextMatch
e.getOwner
e.getPropAlias
e.getRequestEvent
e.hydrate
e.innerHTML
const n = e.insert
e.isDev
e.isServer
e.memo
e.mergeProps
e.render
e.renderToStream
e.renderToString
e.renderToStringAsync
e.resolveSSRNode
e.runHydrationEvents
const F = e.setAttribute
e.setAttributeNS
e.setBoolAttribute
e.setProperty
e.setStyleProperty
e.spread
e.ssr
e.ssrAttribute
e.ssrClassList
e.ssrElement
e.ssrHydrationKey
e.ssrSpread
e.ssrStyle
e.style
const p = e.template
e.untrack
e.use
e.useAssets
const t = globalThis.__OPENCODE_EXTENSION_HOST__?.modules?.["solid-js"]
if (!t) throw new Error("OpenCode host module is unavailable: solid-js")
t.$DEVCOMP
t.$PROXY
t.$TRACK
t.DEV
t.ErrorBoundary
const J = t.For
t.Index
t.Match
const w = t.Show
t.Suspense
t.SuspenseList
t.Switch
t.batch
t.cancelCallback
t.catchError
t.children
t.createComponent
t.createComputed
t.createContext
t.createDeferred
t.createEffect
const T = t.createMemo
t.createReaction
t.createRenderEffect
t.createResource
t.createRoot
t.createSelector
const y = t.createSignal
t.createUniqueId
t.enableExternalSource
t.enableHydration
t.enableScheduling
t.equalFn
t.from
t.getListener
t.getOwner
t.indexArray
t.lazy
t.mapArray
t.mergeProps
t.observable
t.on
t.onCleanup
t.onError
t.onMount
t.requestCallback
t.resetErrorBoundaries
t.runWithOwner
t.sharedConfig
t.splitProps
t.startTransition
t.untrack
t.useContext
t.useTransition
const H = globalThis.__OPENCODE_EXTENSION_HOST__?.modules?.["@opencode-ai/ui/button"]
if (!H) throw new Error("OpenCode host module is unavailable: @opencode-ai/ui/button")
const v = H.Button,
  R = globalThis.__OPENCODE_EXTENSION_HOST__?.modules?.["@opencode-ai/ui/spinner"]
if (!R) throw new Error("OpenCode host module is unavailable: @opencode-ai/ui/spinner")
const K = R.Spinner
var W = /* @__PURE__ */ p("<div class=oc-hello-viewer-status>"),
  U = /* @__PURE__ */ p("<ul class=oc-hello-viewer-log>"),
  Y = /* @__PURE__ */ p(
    "<section class=oc-hello-viewer-root><header class=oc-hello-viewer-header><div><div class=oc-hello-viewer-title>Hello Viewer</div><div class=oc-hello-viewer-path></div></div><div class=oc-hello-viewer-actions></div></header><ol class=oc-hello-viewer-lines></ol><footer class=oc-hello-viewer-console><div class=oc-hello-viewer-console-head><span class=oc-hello-viewer-title>Server bridge</span><span class=oc-hello-viewer-bridge-state></span></div><div class=oc-hello-viewer-console-actions>",
  ),
  x = /* @__PURE__ */ p("<li>"),
  Q = /* @__PURE__ */ p("<div class=oc-hello-viewer-log>Server bridge not provided by this host; viewer-only mode.")
const k = "example.hello-viewer",
  P = `${k}/greeting`,
  [L, A] = y({}),
  [Z, I] = y([]),
  [E, D] = y(void 0),
  ee = () => /* @__PURE__ */ new Date().toLocaleTimeString()
function m(r) {
  I((c) => [...c.slice(-19), `[${ee()}] ${r}`])
}
async function _(r, c) {
  const d = L().rpc
  if (!d) {
    m(`${r}: RPC bridge not available in this host`)
    return
  }
  D(r === "echo" ? "echo" : r === "greet" ? "greet" : "child")
  try {
    m(`${r}: ${await c(d)}`)
  } catch (o) {
    m(`${r} failed: ${o instanceof Error ? o.message : String(o)}`)
  } finally {
    D(void 0)
  }
}
function te(r) {
  const [c, d] = y({
      status: "idle",
    }),
    o = T(() =>
      (r.text() ?? "").split(`
`),
    ),
    l = T(() => L().rpc !== void 0),
    M = async () => {
      d({
        status: "loading",
      })
      try {
        const s = await r.readBytes()
        d({
          status: "ready",
          bytes: s.byteLength,
        })
      } catch (s) {
        d({
          status: "error",
          message: s instanceof Error ? s.message : String(s),
        })
      }
    },
    B = () =>
      void _("echo", async (s) => {
        const u = await s.call("echo", {
          message: `hello from web (${r.file.path})`,
        })
        return JSON.stringify(u)
      }),
    V = () =>
      void _("child", async (s) => {
        await s.call("child.start")
        try {
          const u = await s.call("child.ping", {
            text: `ping (${r.file.name})`,
          })
          return JSON.stringify(u)
        } finally {
          await s.call("child.stop")
        }
      }),
    z = () =>
      void _("greet", async (s) => {
        const u = await s.call("greet", {
          message: `greet me (${r.file.name})`,
        })
        return `server emitted event: ${JSON.stringify(u)}`
      })
  return (() => {
    var s = Y(),
      u = s.firstChild,
      $ = u.firstChild,
      G = $.firstChild,
      X = G.nextSibling,
      C = $.nextSibling,
      S = u.nextSibling,
      O = S.nextSibling,
      N = O.firstChild,
      j = N.firstChild,
      f = j.nextSibling,
      b = N.nextSibling
    return (
      n(X, () => r.file.path),
      n(
        C,
        a(v, {
          size: "small",
          variant: "secondary",
          onClick: () => void M(),
          children: "Inspect bytes",
        }),
        null,
      ),
      n(
        C,
        a(v, {
          size: "small",
          variant: "ghost",
          get onClick() {
            return r.showSource
          },
          children: "Source",
        }),
        null,
      ),
      n(
        s,
        a(w, {
          get when() {
            return c().status !== "idle"
          },
          get children() {
            var i = W()
            return (
              n(
                i,
                a(w, {
                  get when() {
                    return c().status === "loading"
                  },
                  get fallback() {
                    return re(c())
                  },
                  get children() {
                    return [
                      a(K, {
                        class: "oc-hello-viewer-spinner",
                      }),
                      "Reading exact bytes…",
                    ]
                  },
                }),
              ),
              i
            )
          },
        }),
        S,
      ),
      n(S, () =>
        o().map((i) =>
          (() => {
            var g = x()
            return (n(g, i || " "), g)
          })(),
        ),
      ),
      n(f, () => (l() ? "rpc: on" : "rpc: off")),
      n(
        b,
        a(v, {
          size: "small",
          variant: "secondary",
          get disabled() {
            return !l() || E() !== void 0
          },
          onClick: B,
          children: "Echo RPC",
        }),
        null,
      ),
      n(
        b,
        a(v, {
          size: "small",
          variant: "secondary",
          get disabled() {
            return !l() || E() !== void 0
          },
          onClick: V,
          children: "Child ping",
        }),
        null,
      ),
      n(
        b,
        a(v, {
          size: "small",
          variant: "secondary",
          get disabled() {
            return !l() || E() !== void 0
          },
          onClick: z,
          children: "Greet (event)",
        }),
        null,
      ),
      n(
        O,
        a(w, {
          get when() {
            return l()
          },
          get fallback() {
            return Q()
          },
          get children() {
            var i = U()
            return (
              n(
                i,
                a(J, {
                  get each() {
                    return Z()
                  },
                  children: (g) =>
                    (() => {
                      var h = x()
                      return (n(h, g), h)
                    })(),
                }),
              ),
              i
            )
          },
        }),
        null,
      ),
      q(
        (i) => {
          var g = !!l(),
            h = l() ? "ctx.rpc / ctx.events available" : "host did not provide the RPC bridge yet"
          return (g !== i.e && f.classList.toggle("is-on", (i.e = g)), h !== i.t && F(f, "title", (i.t = h)), i)
        },
        {
          e: void 0,
          t: void 0,
        },
      ),
      s
    )
  })()
}
function re(r) {
  return r.status === "ready" ? `${r.bytes} bytes` : r.status === "error" ? r.message : ""
}
const se = {
  id: k,
  apiVersion: 1,
  activate(r) {
    r.log.info("activating hello viewer")
    const c = r.events.on(P, (o) => {
      const l = o && typeof o == "object" ? o : void 0
      m(`event ${P}: ${typeof l?.message == "string" ? l.message : JSON.stringify(o)}`)
    })
    A({
      rpc: r.rpc,
      events: r.events,
    })
    const d = r.fileViewers.register({
      id: "hello",
      component: te,
    })
    return () => {
      ;(d.dispose(), c.dispose(), A({}), I([]))
    }
  },
}
export { se as default }
