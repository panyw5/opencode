import { strict as assert } from "node:assert"
import { withCdp } from "./cdp"

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\//)
  const panel = `document.querySelector('[data-component="quick-assistant-panel"]:not([hidden])')`
  assert.equal(
    await cdp.evaluate(`!!document.querySelector('[role="dialog"], [role="alertdialog"]')`),
    false,
    "close modal dialogs before running the input scroll regression",
  )
  const editor = `${panel}.querySelector('[contenteditable="true"]')`
  const initial = await cdp.evaluate<{ open: boolean; id?: string }>(
    `({open: ${panel}?.dataset.state === 'open', id: ${panel}?.dataset.windowId})`,
  )
  const frame = () =>
    cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
  const inspect = () =>
    cdp.evaluate<{
      scrollTop: number
      clientHeight: number
      scrollHeight: number
      caretTop: number
      caretBottom: number
      viewportTop: number
      viewportBottom: number
      pageScroll: number
    }>(`(() => {
      const e = ${editor};
      const caret = getSelection().getRangeAt(0).getBoundingClientRect();
      const rect = e.getBoundingClientRect();
      return {scrollTop:e.scrollTop,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,
        caretTop:caret.top,caretBottom:caret.bottom,viewportTop:rect.top,viewportBottom:rect.bottom,
        pageScroll:window.scrollY};
    })()`)
  const newline = async () => {
    await cdp.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      modifiers: 8,
      windowsVirtualKeyCode: 13,
    })
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", modifiers: 8 })
    await frame()
  }
  const visible = async () => {
    const view = await inspect()
    assert.ok(view.caretBottom > view.caretTop, "blank new line must have measurable caret geometry")
    assert.ok(view.caretTop >= view.viewportTop, "caret must not be hidden above the editor")
    assert.ok(view.caretBottom <= view.viewportBottom, "caret must not be hidden below the editor")
    return view
  }
  let id: string | undefined
  try {
    if (!initial.open) {
      await cdp.evaluate(`document.querySelector('[data-component="quick-assistant-launcher"]').click()`)
      await frame()
    }
    await cdp.evaluate(`${panel}.querySelector('[data-action="quick-assistant-add-window"]').click()`)
    await frame()
    id = await cdp.evaluate<string>(`${panel}.dataset.windowId`)
    await cdp.evaluate(`${editor}.focus()`)
    assert.equal(
      await cdp.evaluate(`document.activeElement === ${editor}`),
      true,
      "the quick assistant editor must own focus before sending keyboard input",
    )
    const pageScroll = await cdp.evaluate<number>("window.scrollY")
    for (let line = 0; line < 18; line++) {
      await newline()
      await visible()
    }
    const overflow = await visible()
    assert.ok(overflow.scrollHeight > overflow.clientHeight, "test must overflow the input viewport")
    assert.ok(overflow.scrollTop > 0, "new lines must automatically scroll the editor")
    assert.equal(overflow.pageScroll, pageScroll, "caret reveal must not scroll the outer page")
    console.log(`[quick-input-scroll-test] repeated blank lines ${JSON.stringify(overflow)}`)

    await cdp.evaluate(`(() => {
      const e = ${editor};
      e.scrollTop = 0;
      const node = [...e.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)[3];
      const range = document.createRange();
      range.setStart(node, 1); range.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    })()`)
    await newline()
    const middle = await visible()
    assert.ok(
      middle.scrollTop < middle.scrollHeight - middle.clientHeight - 26,
      "editing a middle line must not jump to the end",
    )
    console.log(`[quick-input-scroll-test] middle line ${JSON.stringify(middle)}`)

    await cdp.evaluate(`(() => {
      const e = ${editor};
      e.scrollTop = e.scrollHeight;
      const range = document.createRange();
      range.setStart(e, 0); range.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    })()`)
    await newline()
    const above = await visible()
    assert.ok(above.scrollTop < overflow.scrollTop, "a caret above the viewport must scroll back into view")
    console.log(`[quick-input-scroll-test] above viewport ${JSON.stringify(above)}`)
  } finally {
    if (id) {
      await cdp.evaluate(
        `document.querySelector(${JSON.stringify(`#quick-assistant-tab-${id} ~ [data-action="quick-assistant-close-window"]`)})?.click()`,
      )
    }
    if (initial.id) {
      await cdp.evaluate(`document.getElementById(${JSON.stringify(`quick-assistant-tab-${initial.id}`)})?.click()`)
    }
    if (!initial.open) await cdp.evaluate(`${panel}?.querySelector('[data-action="quick-assistant-hide"]')?.click()`)
  }
})
