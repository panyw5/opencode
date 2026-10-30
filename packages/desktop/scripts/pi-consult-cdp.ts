import { strict as assert } from "node:assert"
import path from "node:path"
import { withCdp } from "./cdp"

// Use the existing dev renderer. No app launch, shutdown, settings mutation, or shortcuts.
const root = path.resolve(import.meta.dir, "../../..")
await withCdp(async (cdp) => {
  const ids = await cdp.evaluate<string[]>("window.api.cliAgents.list().then(items => items.map(item => item.id))")
  assert.ok(
    ids.includes("pi"),
    `Running Electron main process does not expose Pi: ${ids.join(",")}. Rebuild and restart the dev app; renderer module tests alone cannot verify IPC registration.`,
  )
  console.log(`[pi-consult-cdp] live IPC agents=${ids.join(",")}`)
  const result = await cdp.evaluate<{
    reserved: boolean
    ready: string[]
    filtered: string[]
    rendered: boolean
    label: string
  }>(`(async () => {
    const mentions = await import(${JSON.stringify(`/@fs${root}/packages/app/src/components/prompt-input/consult-mentions.ts`)});
    const ui = await import(${JSON.stringify(`/@fs${root}/packages/ui/src/components/message-part.tsx`)});
    const zh = await import(${JSON.stringify(`/@fs${root}/packages/ui/src/i18n/zh.ts`)});
    const ready = await mentions.loadReadyConsultMentions({
      list: async () => [{ id: 'pi', label: 'Pi' }],
      get: async () => ({ enabled: true }),
      info: async () => ({ installed: true }),
    });
    return {
      reserved: mentions.isConsultMentionID('pi'),
      ready: ready.map(item => item.name),
      filtered: mentions.filterAgentsForConsultMentions([{ name: 'pi' }, { name: 'build' }]).map(item => item.name),
      rendered: !!ui.ToolRegistry.render('pi_consult'),
      label: zh.dict['ui.tool.pi'],
    };
  })()`)
  assert.deepEqual(result, { reserved: true, ready: ["pi"], filtered: ["build"], rendered: true, label: "Pi 参谋" })
  console.log(
    "[pi-consult-cdp] PASS Pi mention discovery, reserved-name filtering, tool renderer, and Chinese label in Electron CDP 9222",
  )
  if (process.argv.includes("--settings")) {
    const visible = await cdp.evaluate<boolean>(`(() => {
      const inputs = [...document.querySelectorAll('input')];
      const shown = (el) => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
      return shown(inputs.find(el => el.placeholder === 'pi'))
        && shown(inputs.find(el => el.placeholder === '~/.pi/agent'))
        && document.body.innerText.includes('PI_CODING_AGENT_DIR');
    })()`)
    assert.ok(visible, "Open the Pi settings card: its executable and config-home inputs must be visible")
    console.log("[pi-consult-cdp] PASS actual Pi settings panel and both configuration fields are visible")
  }
})
