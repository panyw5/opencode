import { strict as assert } from "node:assert"
import { writeFile } from "node:fs/promises"
import { DEFAULT_THEMES } from "../../ui/src/theme/default-themes"
import { blend } from "../../ui/src/theme/color"
import { contrastRatio } from "../../ui/src/theme/contrast"
import { resolveThemeVariant } from "../../ui/src/theme/resolve"
import type { HexColor } from "../../ui/src/theme/types"
import { withCdp } from "./cdp"

const log = (message: string) => console.log(`[question-contrast-test] ${message}`)
const variants = Object.entries(DEFAULT_THEMES).flatMap(([id, theme]) =>
  (["light", "dark"] as const).map((mode) => ({ id, mode, tokens: resolveThemeVariant(theme[mode], mode === "dark") })),
)

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  log(`checking ${variants.length} variants in the development Electron renderer`)
  await cdp.call("DOM.enable")
  await cdp.call("CSS.enable")
  try {
    // Isolate the fixture without changing the user's theme, navigation or stored settings.
    await cdp.evaluate(String.raw`(() => {
      const frame = document.createElement('iframe');
      frame.id = 'question-contrast-test';
      frame.style.cssText = 'position:fixed;left:-2000px;top:0;width:900px;height:640px';
      document.body.append(frame);
      const doc = frame.contentDocument;
      for (const sheet of document.styleSheets) {
        const style = doc.createElement('style');
        style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
        doc.head.append(style);
      }
      const style = doc.createElement('style');
      style.textContent = '* { transition: none !important; animation: none !important; }';
      doc.head.append(style);
      doc.body.innerHTML = '<div data-component="session-prompt-dock"><div data-component="dock-prompt" data-kind="question"><div data-slot="question-body" data-dock-surface="shell"><div data-slot="question-options"><button data-slot="question-option"><span data-slot="question-option-main"><span data-slot="option-label">Option label</span><span data-slot="option-description">Option description</span></span></button><form data-slot="question-option" data-custom="true"><span data-slot="question-option-main"><span data-slot="option-label">Custom answer</span><textarea data-slot="question-custom-input" placeholder="Your answer..."></textarea></span></form></div></div></div></div>';
      const collapsed = doc.createElement('div');
      collapsed.dataset.slot = 'question-option';
      collapsed.dataset.custom = 'true';
      collapsed.dataset.qaCollapsed = 'true';
      collapsed.append(doc.querySelector('form [data-slot="question-option-main"]').cloneNode(true));
      const description = doc.createElement('span');
      description.dataset.slot = 'option-description';
      description.textContent = 'Your answer...';
      collapsed.querySelector('textarea').replaceWith(description);
      doc.querySelector('[data-slot="question-options"]').append(collapsed);
      return true;
    })()`)
    await cdp.call("DOM.getDocument", { depth: -1, pierce: true })
    const nodes: number[] = []
    for (const tag of ["button", "form", "[data-qa-collapsed]"]) {
      const result = await cdp.call<{ result: { objectId: string } }>("Runtime.evaluate", {
        expression: `document.getElementById('question-contrast-test').contentDocument.querySelector('${tag}')`,
      })
      const node = await cdp.call<{ nodeId: number }>("DOM.requestNode", { objectId: result.result.objectId })
      nodes.push(node.nodeId)
    }
    const failures: string[] = []
    let checked = 0
    for (const state of ["normal", "hover", "active", "focused", "picked"] as const) {
      const pseudo = state === "hover" ? ["hover"] : state === "active" ? ["hover", "active"] : []
      for (const nodeId of nodes) await cdp.call("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: pseudo })
      const samples = await cdp.evaluate<
        { theme: string; slot: string; foreground: HexColor; background: HexColor }[]
      >(`((variants, state) => {
        const doc = document.getElementById('question-contrast-test').contentDocument;
        const view = doc.defaultView;
        const root = doc.documentElement;
        const canvas = doc.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', {willReadFrequently:true});
        const hex = () => '#' + [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('');
        const background = (el) => {
          const layers = [];
          for (let node = el; node; node = node.parentElement) layers.push(view.getComputedStyle(node).backgroundColor);
          ctx.clearRect(0,0,1,1);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0,0,1,1);
          for (const color of layers.reverse()) { ctx.fillStyle = color; ctx.fillRect(0,0,1,1); }
          return hex();
        };
        const samples = [];
        for (const {id, mode, tokens} of variants) {
          root.style.cssText = '';
          for (const [key, value] of Object.entries(tokens)) root.style.setProperty('--' + key, value);
          root.style.colorScheme = mode;
          root.style.backgroundColor = tokens['background-base'];
          root.dataset.theme = id;
          root.dataset.colorScheme = mode;
          for (const option of doc.querySelectorAll('[data-slot="question-option"]')) {
            option.dataset.picked = String(state === 'picked');
            option.dataset.focused = String(state === 'focused');
          }
          for (const [selector, pseudo] of [
            ['button [data-slot="option-label"]', null],
            ['button [data-slot="option-description"]', null],
            ['form [data-slot="option-label"]', null],
            ['textarea', null],
            ['textarea', '::placeholder'],
            ['[data-qa-collapsed] [data-slot="option-label"]', null],
            ['[data-qa-collapsed] [data-slot="option-description"]', null],
          ]) {
            const el = doc.querySelector(selector);
            const style = view.getComputedStyle(el, pseudo);
            const fill = background(el);
            ctx.fillStyle = fill;
            ctx.fillRect(0,0,1,1);
            ctx.globalAlpha = Number(style.opacity);
            ctx.fillStyle = style.color;
            ctx.fillRect(0,0,1,1);
            ctx.globalAlpha = 1;
            samples.push({theme:id+'/'+mode, slot:selector+(pseudo??''), foreground:hex(), background:fill});
          }
        }
        return samples;
      })(${JSON.stringify(variants)}, ${JSON.stringify(state)})`)
      for (const sample of samples) {
        if (sample.theme === "claude/dark" && (state === "normal" || state === "hover" || state === "picked")) {
          const { tokens } = variants.find((item) => item.id === "claude" && item.mode === "dark")!
          const base = tokens["surface-interactive-base"] as HexColor
          const tinted = blend(tokens["surface-interactive-weak"] as HexColor, base, 0.4)
          const neutral = tokens["surface-raised-stronger-non-alpha"] as HexColor
          const expected = state === "hover" ? base : state === "picked" ? tinted : neutral
          assert.equal(sample.background, expected, `Claude dark ${state} uses the swapped fill`)
        }
        const ratio = contrastRatio(sample.foreground, sample.background)
        checked++
        if (ratio < 4.5) {
          failures.push(
            `${sample.theme} ${state} ${sample.slot}: ${ratio.toFixed(2)} (${sample.foreground}/${sample.background})`,
          )
        }
      }
      log(`${state}: checked ${samples.length} label, description, input and placeholder colors`)
    }
    for (const failure of failures) log(`FAIL ${failure}`)
    assert.equal(failures.length, 0, `${failures.length}/${checked} foregrounds below 4.5:1`)
    log(`PASS ${checked} rendered contrast checks meet WCAG AA (4.5:1)`)
    const screenshot = Bun.argv[Bun.argv.indexOf("--screenshot") + 1]
    if (Bun.argv.includes("--screenshot") && screenshot) {
      const variant = variants.find((item) => item.id === "claude" && item.mode === "light")!
      await cdp.evaluate(`((variant) => {
        const frame = document.getElementById('question-contrast-test');
        frame.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:400px;z-index:2147483647;border:0';
        const doc = frame.contentDocument;
        const root = doc.documentElement;
        for (const [key,value] of Object.entries(variant.tokens)) root.style.setProperty('--'+key,value);
        root.style.colorScheme = variant.mode;
        root.style.backgroundColor = variant.tokens['background-base'];
        root.dataset.theme = variant.id;
        root.dataset.colorScheme = variant.mode;
        for (const option of doc.querySelectorAll('[data-slot="question-option"]')) {
          option.dataset.picked = String(option.tagName === 'FORM');
          option.dataset.focused = 'false';
        }
        doc.querySelector('[data-slot="question-body"]').style.padding = '24px';
      })(${JSON.stringify(variant)})`)
      const image = await cdp.call<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: 900, height: 400, scale: 1 },
      })
      await writeFile(screenshot, Buffer.from(image.data, "base64"))
      log(`saved Claude light selected-answer screenshot to ${screenshot}`)
    }
  } finally {
    await cdp.evaluate("document.getElementById('question-contrast-test')?.remove()")
    await cdp.call("CSS.disable")
    await cdp.call("DOM.disable")
  }
})
