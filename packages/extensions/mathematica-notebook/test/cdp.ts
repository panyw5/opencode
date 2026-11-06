import { strict as assert } from "node:assert"
import { writeFile } from "node:fs/promises"
import { CdpClient, listTargets, withCdp } from "../../../desktop/scripts/cdp"

// Open examples/demo.nb in the development renderer before running this script.
async function verify(cdp: CdpClient) {
  // Electron suppresses ResizeObserver delivery for hidden windows.
  await cdp.evaluate("window.api.showWindow()")
  const wait = async (expression: string, timeout = 90_000) => {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      if (await cdp.evaluate(expression)) return
      const error = await cdp.evaluate<string | undefined>("document.querySelector('.oc-nb [role=alert]')?.textContent")
      if (error) throw new Error(`Notebook CDP request failed: ${error}`)
      await Bun.sleep(100)
    }
    throw new Error(`Notebook CDP condition timed out: ${expression}`)
  }
  const click = (text: string) =>
    cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.oc-nb-toolbar button')].find(x => x.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(text)});
    button.click(); return true;
  })()`)
  const edit = (index: number, value: string) =>
    cdp.evaluate(`(() => {
    const input = document.querySelector('.oc-nb [data-cell-index="${index}"] textarea');
    input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); return true;
  })()`)
  await wait("document.querySelectorAll('.oc-nb textarea').length === 5")
  await wait("!!document.querySelector('.oc-nb [data-cell-index=\"2\"] .oc-nb-highlight [data-token=number]')")
  await cdp.evaluate("document.fonts.ready.then(() => true)")
  const toolbarLayout = await cdp.evaluate<{
    headers: number
    heading: boolean
    hosted: boolean
    defaultsHidden: boolean
    buttons: string[]
    gap: number
    height: number
  }>(`(() => {
    const root=document.querySelector('.oc-nb');const surface=root.closest('[data-extension]');
    const row=surface.querySelector('[data-slot="file-viewer-toolbar"]');const toolbar=surface.querySelector('.oc-nb-toolbar');
    return {headers:surface.querySelectorAll('.oc-nb-toolbar').length,heading:!!surface.querySelector('.oc-nb-heading'),
      hosted:!!row?.contains(toolbar),defaultsHidden:surface.querySelector('[data-slot="file-viewer-default-toolbar"]')?.hidden,
      buttons:[...toolbar.querySelectorAll('button')].map(x=>x.textContent.trim()),
      gap:root.getBoundingClientRect().top-row.getBoundingClientRect().bottom,height:row.getBoundingClientRect().height};
  })()`)
  assert.equal(toolbarLayout.headers, 1)
  assert.equal(toolbarLayout.heading, false)
  assert.equal(toolbarLayout.hosted, true)
  assert.equal(toolbarLayout.defaultsHidden, true)
  assert.deepEqual(toolbarLayout.buttons, ["Run all", "Stop / reset", "Save", "Reload", "Source"])
  assert.ok(Math.abs(toolbarLayout.gap) < 2, "Notebook must start immediately below its single toolbar row")
  assert.ok(toolbarLayout.height < 64, "Normal-width toolbar must remain compact")
  console.log("[notebook-toolbar] PASS: single hosted row, no heading/default controls, five actions")
  const layout = await cdp.evaluate<{
    padding: number
    paperInset: number
    labelInset: number
    paperWidth: number
    availableWidth: number
    gutter: number
    narrowGlyph: number
    wideGlyph: number
    font: string
    mirrorFont: string
  }>(`(() => {
    const root=document.querySelector('.oc-nb');
    const paper=root.querySelector('.oc-nb-paper');
    const cell=root.querySelector('[data-cell-index="2"]');
    const field=cell.querySelector('textarea');
    const mirror=cell.querySelector('.oc-nb-highlight');
    const range=document.createRange();range.selectNodeContents(cell.querySelector('.oc-nb-cell-label'));
    const style=getComputedStyle(field);
    const context=document.createElement('canvas').getContext('2d');
    // The font shorthand is empty when font-variant-ligatures is non-default.
    context.font=style.fontStyle+' '+style.fontWeight+' '+style.fontSize+' '+style.fontFamily;
    return {padding:parseFloat(getComputedStyle(paper).paddingLeft),paperInset:paper.getBoundingClientRect().left-root.getBoundingClientRect().left,
      labelInset:range.getBoundingClientRect().left-root.getBoundingClientRect().left,
      paperWidth:paper.getBoundingClientRect().width,availableWidth:root.clientWidth,
      gutter:parseFloat(getComputedStyle(cell).gridTemplateColumns),font:getComputedStyle(field).fontFamily,mirrorFont:getComputedStyle(mirror).fontFamily,
      narrowGlyph:context.measureText('iiiiiiii').width,wideGlyph:context.measureText('WWWWWWWW').width};
  })()`)
  console.log("[notebook-layout] " + JSON.stringify(layout))
  assert.equal(layout.padding, 0, "Notebook must not retain a left paper margin")
  assert.ok(
    Math.abs(layout.paperInset) < 1 && Math.abs(layout.paperWidth - layout.availableWidth) < 1,
    "Notebook must fill its panel without centered whitespace",
  )
  assert.ok(layout.gutter <= 64 && layout.labelInset < 20, "Cell labels must sit close to the panel edge")
  assert.ok(Math.abs(layout.narrowGlyph - layout.wideGlyph) < 0.1, "Input font must have equal-width Latin glyphs")
  assert.equal(layout.font, layout.mirrorFont, "Input and syntax layer must use the same font")
  const override = await cdp.evaluate(`(() => {
    const root=document.querySelector('.oc-nb');root.style.setProperty('--font-family-mono','Georgia, serif');
    try {const field=root.querySelector('[data-cell-index="2"] textarea');return getComputedStyle(field).fontFamily}
    finally {root.style.removeProperty('--font-family-mono')}
  })()`)
  assert.equal(override, layout.font, "Global font overrides must not make Input cells proportional")
  const runPlacement = await cdp.evaluate(`(() => {
    const buttons=[...document.querySelectorAll('.oc-nb .oc-nb-run')];
    return buttons.length===3 && buttons.every(button=>{
      const label=button.closest('.oc-nb-label');if(!label)return false;
      const text=label.querySelector('.oc-nb-cell-label').getBoundingClientRect();
      const bounds=button.getBoundingClientRect();const gutter=label.getBoundingClientRect();
      return bounds.top>=text.bottom+4 && bounds.left>=gutter.left && bounds.right<=gutter.right;
    }) && !document.querySelector('.oc-nb-content .oc-nb-run');
  })()`)
  assert.equal(runPlacement, true, "Run buttons must sit below In[n] in the left gutter")
  assert.equal(await cdp.evaluate("!!document.querySelector('.oc-nb [data-style=Title] .oc-nb-highlight')"), false)
  const original = await cdp.evaluate<string>("document.querySelector('.oc-nb [data-cell-index=\"2\"] textarea').value")
  const code =
    "(* outer (* nested *) comment *)\n" + 'Print["<b>hello</b>"]; Sin[Pi/2] + 1.25`30*^-6;\n'.repeat(80) + "21*2"
  await edit(2, code)
  await wait(
    "document.querySelector('.oc-nb [data-cell-index=\"2\"] .oc-nb-highlight').textContent.replace(/\\u200b$/, '') === document.querySelector('.oc-nb [data-cell-index=\"2\"] textarea').value",
  )
  const colors = await cdp.evaluate<string[]>(
    `[...document.querySelectorAll('.oc-nb [data-cell-index="2"] [data-token]')].map(x=>getComputedStyle(x).color)`,
  )
  assert.ok(new Set(colors).size >= 3, "Expected distinct Wolfram token colors")
  assert.equal(await cdp.evaluate("document.querySelectorAll('.oc-nb .oc-nb-highlight b').length"), 0)
  await cdp.evaluate(`(() => {
    const field=document.querySelector('.oc-nb [data-cell-index="2"] textarea');
    field.focus(); field.setSelectionRange(field.value.length, field.value.length);
    return true;
  })()`)
  await cdp.call("Input.insertText", { text: "\n(* typed *)" })
  await wait(
    "document.querySelector('.oc-nb [data-cell-index=\"2\"] .oc-nb-highlight').textContent.endsWith('(* typed *)\\u200b')",
  )
  assert.ok(
    await cdp.evaluate(`(() => {
    const field=document.querySelector('.oc-nb [data-cell-index="2"] textarea');
    const mirror=document.querySelector('.oc-nb [data-cell-index="2"] .oc-nb-highlight');
    field.scrollTop=100; field.dispatchEvent(new Event('scroll'));
    return Math.abs(field.scrollTop-mirror.scrollTop)<1 && field.scrollTop>0
      && getComputedStyle(field).font === getComputedStyle(mirror).font
      && Math.abs(field.clientWidth-mirror.clientWidth)<1;
  })()`),
    "Highlight overlay must stay aligned while scrolling",
  )
  await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] })
  try {
    assert.equal(
      await cdp.evaluate("getComputedStyle(document.querySelector('.oc-nb .oc-nb-highlight')).visibility"),
      "hidden",
    )
    assert.notEqual(
      await cdp.evaluate("getComputedStyle(document.querySelector('.oc-nb .is-code textarea')).webkitTextFillColor"),
      "rgba(0, 0, 0, 0)",
    )
  } finally {
    await cdp.call("Emulation.setEmulatedMedia", { features: [] })
  }
  await edit(2, "q=6")
  await cdp.evaluate("document.querySelector('.oc-nb [aria-label=\"Run cell 3\"]').click(); true")
  await wait(
    "document.querySelector('.oc-nb [data-cell-index=\"2\"] .oc-nb-output pre')?.textContent === '6' && !document.querySelector('.oc-nb [aria-label=\"Run cell 3\"]').disabled",
  )
  await click("Run all")
  await wait(
    "!!document.querySelector('.oc-nb [data-cell-index=\"4\"] .oc-nb-output img') && !document.querySelector('.oc-nb [aria-label=\"Run cell 3\"]').disabled",
  )
  assert.equal(
    await cdp.evaluate("document.querySelector('.oc-nb [data-cell-index=\"3\"] .oc-nb-output pre').textContent"),
    "42",
  )
  assert.ok(
    await cdp.evaluate("document.querySelector('.oc-nb [data-cell-index=\"4\"] .oc-nb-output img').naturalWidth > 0"),
  )
  const updated = original === "q = 7" ? "q = 8" : "q = 7"
  await edit(2, updated)
  await click("Save *")
  await wait(
    "[...document.querySelectorAll('.oc-nb-toolbar button')].some(x => x.textContent === 'Save' && x.disabled)",
  )
  assert.equal(await cdp.evaluate("document.querySelector('.oc-nb [data-cell-index=\"2\"] textarea').value"), updated)
  await click("Reload")
  await wait(`document.querySelector('.oc-nb [data-cell-index="2"] textarea')?.value === ${JSON.stringify(updated)}`)
  await edit(2, "q=6")
  await click("Save *")
  await wait(
    "[...document.querySelectorAll('.oc-nb-toolbar button')].some(x => x.textContent === 'Save' && x.disabled)",
  )
  await click("Run all")
  await wait(
    "!!document.querySelector('.oc-nb [data-cell-index=\"4\"] .oc-nb-output img') && !document.querySelector('.oc-nb [aria-label=\"Run cell 3\"]').disabled",
  )
  assert.equal(await cdp.evaluate("document.querySelector('.oc-nb [role=alert]')?.textContent ?? ''"), "")
  await cdp.evaluate("document.querySelector('.oc-nb').style.width = '430px'; true")
  try {
    await wait("[...document.querySelectorAll('.oc-nb textarea')].every(x => x.scrollHeight <= x.clientHeight + 2)")
  } finally {
    await cdp.evaluate("document.querySelector('.oc-nb').style.removeProperty('width'); true")
  }
  await cdp.evaluate("document.querySelector('.oc-nb').closest('[data-extension]').style.width='320px';true")
  try {
    await wait(
      `(()=>{const r=document.querySelector('.oc-nb');const surface=r.closest('[data-extension]');const row=surface.querySelector('[data-slot="file-viewer-toolbar"]');const b=row.getBoundingClientRect();return Math.abs(r.getBoundingClientRect().top-b.bottom)<2 && [...row.querySelectorAll('.oc-nb-toolbar button')].every(x=>{const a=x.getBoundingClientRect();return a.left>=b.left && a.right<=b.right+1})})()`,
    )
  } finally {
    await cdp.evaluate(
      "document.querySelector('.oc-nb').closest('[data-extension]').style.removeProperty('width');true",
    )
  }
  if (original !== "q=6") {
    await edit(2, original)
    await click("Save *")
    await wait(
      "[...document.querySelectorAll('.oc-nb-toolbar button')].some(x => x.textContent === 'Save' && x.disabled)",
    )
  }
  const screenshot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
  await writeFile("/tmp/notebook-toolbar-compact.png", Buffer.from(screenshot.data, "base64"))
  await click("Stop / reset")
  await wait("document.querySelector('.oc-nb [role=status]')?.textContent.includes('Kernel stopped')")
  await click("Source")
  await wait("![...document.querySelectorAll('.oc-nb')].some(x=>x.getClientRects().length)")
  console.log(
    "[notebook-cdp] PASS: compact hosted toolbar, narrow wrapping, Source/Stop, Run below In[n], individual run (6), highlighting/typing/scrolling, run-all (42), PNG, save/reload",
  )
}

if (process.env.OPENCODE_CDP_TARGET_ID) {
  const target = (await listTargets()).find((item) => item.id === process.env.OPENCODE_CDP_TARGET_ID)
  assert.ok(target, "Requested CDP target not found")
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
  try {
    await verify(cdp)
  } finally {
    cdp.close()
  }
} else {
  await withCdp(verify)
}
