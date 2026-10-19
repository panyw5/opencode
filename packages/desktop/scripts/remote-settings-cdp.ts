#!/usr/bin/env bun
import { connectCdp } from "./cdp"

const { client } = await connectCdp()
let enabledByTest = false

async function status() {
  return client.evaluate<{ enabled: boolean; phase: string; url?: string; error?: string }>(
    "window.api.remoteAccess.status()",
  )
}

async function enableConsent(accept: boolean) {
  const click = client
    .evaluate(
      `(() => {
    const button=[...document.querySelectorAll('button')].find(e=>['启用远程访问','Enable remote access'].includes(e.textContent.trim()));
    if(!button)throw new Error('Remote settings enable button not found');
    button.click();
    return true;
  })()`,
    )
    .then(
      () => ({ ok: true as const }),
      (error: Error) => ({ ok: false as const, message: error.message }),
    )
  await Bun.sleep(100)
  await client.call("Page.handleJavaScriptDialog", { accept }).catch(async (error) => {
    const result = await click
    if (!result.ok) throw new Error(result.message)
    throw error
  })
  const result = await click
  if (!result.ok) throw new Error(result.message)
}

try {
  if ((await status()).enabled) throw new Error("Remote access is already enabled; this QA will not disturb it")
  await client.call("Page.enable")
  await client.evaluate(`(() => {
    const button=[...document.querySelectorAll('button')].find(e=>['设置','Settings'].includes((e.getAttribute('aria-label')||e.textContent).trim()));
    if(!button)throw new Error('Settings button not found');
    button.click();
  })()`)
  await Bun.sleep(100)
  await client.evaluate(`(() => {
    const tab=[...document.querySelectorAll('[role=tab]')].find(e=>['远程访问','Remote access'].includes(e.textContent.trim()));
    if(!tab)throw new Error('Remote access tab not found');
    tab.click();
  })()`)
  await Bun.sleep(100)
  await enableConsent(false)
  if ((await status()).enabled) throw new Error("Cancelling consent enabled remote access")
  console.log("[remote-settings-cdp] first-enable consent cancellation verified")
  if (!process.argv.includes("--live")) {
    console.log("[remote-settings-cdp] PASS; live public exposure requires separate approval and --live")
  } else {
    enabledByTest = true
    await enableConsent(true)
    const deadline = Date.now() + 240_000
    let lastPhase = ""
    let ready = false
    while (Date.now() < deadline) {
      const current = await status()
      if (current.phase !== lastPhase) {
        console.log(`[remote-settings-cdp] phase=${current.phase} enabled=${current.enabled}`)
        lastPhase = current.phase
      }
      if (current.phase === "error") throw new Error(current.error ?? "Remote worker failed")
      if (current.phase === "online" && current.url?.startsWith("https://")) {
        ready = true
        break
      }
      await Bun.sleep(500)
    }
    if (!ready) throw new Error("Remote worker did not become online")
    await client.evaluate(`(() => {
    const button=[...document.querySelectorAll('button')].find(e=>['配对设备','Pair device'].includes(e.textContent.trim()));
    if(!button)throw new Error('Remote settings pair button not found');
    button.click();
  })()`)
    let hasQr = false
    for (let attempt = 0; attempt < 40; attempt++) {
      hasQr = await client.evaluate<boolean>(
        `[...document.querySelectorAll('img')].some(e=>e.src.startsWith('data:image/png')&&e.naturalWidth>0)`,
      )
      if (hasQr) break
      await Bun.sleep(100)
    }
    if (!hasQr) throw new Error("Pair action did not render a real local QR image")
    console.log("[remote-settings-cdp] live encrypted worker online and pairing QR rendered")
    await client.evaluate("window.api.remoteAccess.disable()")
    enabledByTest = false
    const stopped = await status()
    if (stopped.enabled || stopped.phase !== "disabled") throw new Error("Remote access did not stop")
    const staleQr = await client.evaluate<boolean>(
      `[...document.querySelectorAll('img')].some(e=>e.src.startsWith('data:image/png'))`,
    )
    if (staleQr) throw new Error("Disabled remote settings retained a stale pairing QR")
    console.log("[remote-settings-cdp] disabled=true staleQr=false; PASS")
  }
} finally {
  if (enabledByTest) await client.evaluate("window.api.remoteAccess.disable()").catch(() => {})
  client.close()
}
