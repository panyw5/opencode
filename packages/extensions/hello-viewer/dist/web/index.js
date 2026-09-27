const e = globalThis.__OPENCODE_EXTENSION_HOST__?.modules?.["solid-js/web"];
if (!e) throw new Error("OpenCode host module is unavailable: solid-js/web");
e.Aliases;
e.Assets;
e.ChildProperties;
e.DOMElements;
e.DelegatedEvents;
e.Dynamic;
e.ErrorBoundary;
e.For;
e.Hydration;
e.HydrationScript;
e.Index;
e.Match;
e.NoHydration;
e.Portal;
e.Properties;
e.RequestContext;
e.SVGElements;
e.SVGNamespace;
e.Show;
e.Suspense;
e.SuspenseList;
e.Switch;
e.addEventListener;
e.assign;
e.classList;
e.className;
e.clearDelegatedEvents;
const i = e.createComponent;
e.createDynamic;
e.delegateEvents;
e.dynamicProperty;
e.effect;
e.escape;
e.generateHydrationScript;
e.getAssets;
e.getHydrationKey;
e.getNextElement;
e.getNextMarker;
e.getNextMatch;
e.getOwner;
e.getPropAlias;
e.getRequestEvent;
e.hydrate;
e.innerHTML;
const n = e.insert;
e.isDev;
e.isServer;
e.memo;
e.mergeProps;
e.render;
e.renderToStream;
e.renderToString;
e.renderToStringAsync;
e.resolveSSRNode;
e.runHydrationEvents;
e.setAttribute;
e.setAttributeNS;
e.setBoolAttribute;
e.setProperty;
e.setStyleProperty;
e.spread;
e.ssr;
e.ssrAttribute;
e.ssrClassList;
e.ssrElement;
e.ssrHydrationKey;
e.ssrSpread;
e.ssrStyle;
e.style;
const c = e.template;
e.untrack;
e.use;
e.useAssets;
const t = globalThis.__OPENCODE_EXTENSION_HOST__?.modules?.["solid-js"];
if (!t) throw new Error("OpenCode host module is unavailable: solid-js");
t.$DEVCOMP;
t.$PROXY;
t.$TRACK;
t.DEV;
t.ErrorBoundary;
t.For;
t.Index;
t.Match;
const m = t.Show;
t.Suspense;
t.SuspenseList;
t.Switch;
t.batch;
t.cancelCallback;
t.catchError;
t.children;
t.createComponent;
t.createComputed;
t.createContext;
t.createDeferred;
t.createEffect;
const f = t.createMemo;
t.createReaction;
t.createRenderEffect;
t.createResource;
t.createRoot;
t.createSelector;
const C = t.createSignal;
t.createUniqueId;
t.enableExternalSource;
t.enableHydration;
t.enableScheduling;
t.equalFn;
t.from;
t.getListener;
t.getOwner;
t.indexArray;
t.lazy;
t.mapArray;
t.mergeProps;
t.observable;
t.on;
t.onCleanup;
t.onError;
t.onMount;
t.requestCallback;
t.resetErrorBoundaries;
t.runWithOwner;
t.sharedConfig;
t.splitProps;
t.startTransition;
t.untrack;
t.useContext;
t.useTransition;
const E = globalThis.__OPENCODE_EXTENSION_HOST__?.modules?.["@opencode-ai/ui/button"];
if (!E) throw new Error("OpenCode host module is unavailable: @opencode-ai/ui/button");
const S = E.Button, v = globalThis.__OPENCODE_EXTENSION_HOST__?.modules?.["@opencode-ai/ui/spinner"];
if (!v) throw new Error("OpenCode host module is unavailable: @opencode-ai/ui/spinner");
const O = v.Spinner;
var N = /* @__PURE__ */ c("<div class=oc-hello-viewer-status>"), T = /* @__PURE__ */ c("<section class=oc-hello-viewer-root><header class=oc-hello-viewer-header><div><div class=oc-hello-viewer-title>Hello Viewer</div><div class=oc-hello-viewer-path></div></div><div class=oc-hello-viewer-actions></div></header><ol class=oc-hello-viewer-lines>"), $ = /* @__PURE__ */ c("<li>");
function x(r) {
  const [o, l] = C({
    status: "idle"
  }), y = f(() => (r.text() ?? "").split(`
`)), b = async () => {
    l({
      status: "loading"
    });
    try {
      const s = await r.readBytes();
      l({
        status: "ready",
        bytes: s.byteLength
      });
    } catch (s) {
      l({
        status: "error",
        message: s instanceof Error ? s.message : String(s)
      });
    }
  };
  return (() => {
    var s = T(), d = s.firstChild, u = d.firstChild, w = u.firstChild, _ = w.nextSibling, h = u.nextSibling, g = d.nextSibling;
    return n(_, () => r.file.path), n(h, i(S, {
      size: "small",
      variant: "secondary",
      onClick: () => void b(),
      children: "Inspect bytes"
    }), null), n(h, i(S, {
      size: "small",
      variant: "ghost",
      get onClick() {
        return r.showSource;
      },
      children: "Source"
    }), null), n(s, i(m, {
      get when() {
        return o().status !== "idle";
      },
      get children() {
        var a = N();
        return n(a, i(m, {
          get when() {
            return o().status === "loading";
          },
          get fallback() {
            return P(o());
          },
          get children() {
            return [i(O, {
              class: "oc-hello-viewer-spinner"
            }), "Reading exact bytes…"];
          }
        })), a;
      }
    }), g), n(g, () => y().map((a) => (() => {
      var p = $();
      return n(p, a || " "), p;
    })())), s;
  })();
}
function P(r) {
  return r.status === "ready" ? `${r.bytes} bytes` : r.status === "error" ? r.message : "";
}
const H = {
  id: "example.hello-viewer",
  apiVersion: 1,
  activate(r) {
    r.log.info("activating hello viewer");
    const o = r.fileViewers.register({
      id: "hello",
      component: x
    });
    return () => o.dispose();
  }
};
export {
  H as default
};
