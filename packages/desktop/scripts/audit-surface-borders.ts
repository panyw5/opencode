import { strict as assert } from "node:assert"
import { withCdp } from "./cdp"

// Exercise the shipped CSS cascade, including theme overrides and desktop rules.
await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const result = await cdp.evaluate<{ checks: number; failures: string[] }>(String.raw`(() => {
    const root = document.documentElement;
    const attributes = ["data-theme", "data-color-scheme", "data-platform", "data-os", "style"];
    const original = attributes.map(name => [name, root.getAttribute(name)]);
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-10000px;pointer-events:none";
    const samples = [];
    const element = (attributes, parent = host, tag = "div") => {
      const node = document.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      parent.append(node);
      return node;
    };
    const sample = (name, node, border = false) => samples.push({name, node, border});
    for (const name of ["popover-content", "dropdown-menu-content", "dropdown-menu-sub-content",
      "context-menu-content", "context-menu-sub-content", "select-content", "hover-card-content"]) {
      const node = element({"data-component": name});
      sample(name, node, true);
      if (name.includes("menu")) {
        const slot = name.startsWith("context") ? "context-menu-item" : "dropdown-menu-item";
        sample(name + "/highlighted", element({"data-slot": slot, "data-highlighted": ""}, node));
      }
    }
    sample("dialog", element({"data-slot": "dialog-content"},
      element({"data-slot": "dialog-container"}, element({"data-component": "dialog"}))), true);
    for (const compact of [false, true]) {
      sample("toast/" + compact, element({"data-component": "toast", "data-variant": "default",
        ...(compact ? {"data-compact": ""} : {})}), true);
    }
    sample("sidebar-actions", element({"class": "sidebar-actions"}), true);
    sample("sidebar-session", element({"data-component": "sidebar-session", "data-active": "true"}));
    sample("sidebar-panel", element({"data-component": "sidebar-panel"}));
    sample("permission-capsule", element({"data-component": "session-tab-permission-capsule"}));
    for (const role of ["user", "assistant"]) {
      sample("quick-assistant/" + role, element({"data-slot": "quick-assistant-bubble"},
        element({"data-component": "quick-assistant-message", "data-role": role})));
    }
    sample("message", element({"data-slot": "user-message-text"}, element({"data-component": "user-message"})));
    sample("subagent-stat", element({"data-slot": "subagent-task-stat"}));
    for (const syntax of ["svg", "mermaid", "flowchart"]) {
      sample("diagram/" + syntax, element({"class": "diagram-card__preview"},
        element({"data-component": "diagram-card", "data-diagram-syntax": syntax})));
    }
    sample("config-editor-toggle", element({"class": "config-editor-mode-toggle__group"}), true);
    const failures = [];
    let checks = 0;
    document.body.append(host);
    try {
      for (const theme of ["oc-2", "claude", "chatgpt", "arc", "aether"]) {
        root.dataset.theme = theme;
        for (const scheme of ["light", "dark"]) {
          root.dataset.colorScheme = scheme;
          root.style.colorScheme = scheme;
          for (const platform of ["desktop", "web"]) {
            root.dataset.platform = platform;
            for (const os of ["macos", "windows", "linux"]) {
              root.dataset.os = os;
              const prefix = [theme, scheme, platform, os].join("/");
              for (const {name, node, border} of samples) {
                const style = getComputedStyle(node);
                checks++;
                if (style.boxShadow.includes("inset")) failures.push(prefix + "/" + name + " shadow=" + style.boxShadow);
                if (border && style.borderTopWidth !== "1px") failures.push(prefix + "/" + name + " border=" + style.borderTopWidth);
                if (border) {
                  const shadows = style.boxShadow.replace(/[a-z]+\([^)]*\)/gi, "").split(",");
                  const ring = shadows.some(shadow => {
                    const lengths = shadow.match(/-?[\d.]+px/g)?.map(parseFloat);
                    return lengths?.length === 4 && lengths[0] === 0 && lengths[1] === 0 && lengths[2] === 0 && lengths[3] > 0;
                  });
                  if (ring) failures.push(prefix + "/" + name + " duplicates border with outer ring=" + style.boxShadow);
                }
                if (name.endsWith("/highlighted") && style.backgroundColor === "rgba(0, 0, 0, 0)") {
                  failures.push(prefix + "/" + name + " lost keyboard highlight background");
                }
              }
            }
          }
        }
      }
      return { checks, failures };
    } finally {
      host.remove();
      for (const [name, value] of original) {
        if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      }
    }
  })()`)
  for (const failure of result.failures) console.error(`[surface-borders] ${failure}`)
  assert.equal(result.failures.length, 0, `${result.failures.length}/${result.checks} surface border checks failed`)
  console.info(`[surface-borders] passed ${result.checks} checks across themes, schemes, platforms and OS variants`)
})
