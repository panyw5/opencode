import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import path from "node:path"
import { CdpClient, connectCdp } from "./cdp"

const endpoint = Bun.env.OPENCODE_CDP_ENDPOINT || "http://127.0.0.1:9222"
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const visible = (el: Element) => {
  const style = getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.contentVisibility !== "hidden" &&
    !el.closest('[inert],[hidden],[aria-hidden="true"]')
  )
}

type ResolverDiagnostics = {
  editorCount: number
  composerCount: number
  globalInputCount: number
  eligibleGlobalInputCount: number
  scopedInputCount: number
  reason: string
}

type ActiveInput = ResolverDiagnostics & {
  nodeId: number
  backendNodeId: number
  multiple: boolean
}

export function openCodeComposerTarget() {
  const editorSelector = '[data-component="prompt-input"][contenteditable="true"][role="textbox"]'
  const inputSelector = 'input[type="file"]'
  const hiddenStyle = (el: Element) => {
    for (let current: Element | null = el; current; current = current.parentElement) {
      const style = getComputedStyle(current)
      const inline = (current.getAttribute("style") ?? "").toLowerCase().replace(/\s/g, "")
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.contentVisibility === "hidden" ||
        /(?:^|;)display:none(?:;|$)/.test(inline) ||
        /(?:^|;)visibility:hidden(?:;|$)/.test(inline) ||
        /(?:^|;)content-visibility:hidden(?:;|$)/.test(inline)
      )
        return true
    }
    return false
  }
  const visible = (el: Element) =>
    el.getClientRects().length > 0 &&
    !hiddenStyle(el) &&
    !el.closest('[inert],[hidden],[aria-hidden="true"]')
  const editors = [...document.querySelectorAll<HTMLElement>(editorSelector)].filter(visible)
  const globalInputs = [...document.querySelectorAll<HTMLInputElement>(inputSelector)]
  const result = {
    editor: null as HTMLElement | null,
    composer: null as HTMLElement | null,
    input: null as HTMLInputElement | null,
    editorCount: editors.length,
    composerCount: 0,
    globalInputCount: globalInputs.length,
    eligibleGlobalInputCount: globalInputs.filter((input) =>
      input.type === "file" &&
      !input.disabled &&
      input.getAttribute("aria-disabled") !== "true" &&
      !input.parentElement?.closest('[inert],[hidden],[aria-hidden="true"]'),
    ).length,
    scopedInputCount: 0,
    reason: "ok" as "ok" | "no-editor" | "ambiguous-editor" | "no-composer" | "no-scoped-input" | "ambiguous-scoped-input",
  }
  if (!editors.length) {
    result.reason = "no-editor"
    return result
  }
  if (editors.length !== 1) {
    result.reason = "ambiguous-editor"
    return result
  }
  result.editor = editors[0]
  const composer = result.editor.closest<HTMLElement>("[data-prompt-composer]")
  if (!composer || !visible(composer)) {
    result.reason = "no-composer"
    return result
  }
  result.composer = composer
  result.composerCount = 1
  const scopedInputs = [...composer.querySelectorAll<HTMLInputElement>(inputSelector)].filter(
    (input) =>
      input.type === "file" &&
      !input.disabled &&
      input.getAttribute("aria-disabled") !== "true" &&
      !input.parentElement?.closest('[inert],[hidden],[aria-hidden="true"]'),
  )
  result.scopedInputCount = scopedInputs.length
  if (!scopedInputs.length) {
    result.reason = "no-scoped-input"
    return result
  }
  if (scopedInputs.length !== 1) {
    result.reason = "ambiguous-scoped-input"
    return result
  }
  result.input = scopedInputs[0]
  return result
}

const OPEN_CODE_COMPOSER_TARGET = `(${openCodeComposerTarget.toString()})()`

export function mentionCandidateMatches(label: string, query: string) {
  return label.trim().toLowerCase().includes(query.trim().toLowerCase())
}

export function mentionTokenMatches(type: string, name: string, query: string) {
  return (type === "file" || type === "agent") && name.toLowerCase().includes(query.trim().toLowerCase())
}

export function openCodeSendReadyExpression() {
  return `(() => {
    const target=${OPEN_CODE_COMPOSER_TARGET}
    const root=target.editor?.closest('[data-prompt-composer]')
    const button=root?.querySelector('[data-action="prompt-submit"]')
    return !!button && (${visible.toString()})(button) && !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true' && button.dataset.icon !== 'stop' && button.dataset.icon !== 'arrow-sync'
  })()`
}

export async function activeInput(client: CdpClient): Promise<ActiveInput> {
  await client.call("DOM.enable")
  const document = await client.call<{ root?: { nodeId?: number } }>("DOM.getDocument", { depth: 0 })
  if (!document.root?.nodeId) throw new Error("Active OpenCode composer document could not be resolved")
  const handle = (await client.call<{ result?: { objectId?: string } }>("Runtime.evaluate", {
    expression: OPEN_CODE_COMPOSER_TARGET,
    returnByValue: false,
  })).result?.objectId
  if (!handle) throw new Error("Composer resolver returned no result")
  let inputHandle: string | undefined
  try {
    const diagnostics = await client.call<{ result?: { value?: ResolverDiagnostics } }>("Runtime.callFunctionOn", {
      objectId: handle,
      functionDeclaration:
        "function() { return {editorCount:this.editorCount,composerCount:this.composerCount,globalInputCount:this.globalInputCount,eligibleGlobalInputCount:this.eligibleGlobalInputCount,scopedInputCount:this.scopedInputCount,reason:this.reason} }",
      returnByValue: true,
    })
    const summary = diagnostics.result?.value
    if (!summary || summary.reason !== "ok") {
      const reason = summary?.reason ?? "missing"
      throw new Error(
        `Active OpenCode composer file input unavailable: editors=${summary?.editorCount ?? -1} composers=${summary?.composerCount ?? -1} global=${summary?.globalInputCount ?? -1} eligible=${summary?.eligibleGlobalInputCount ?? -1} scoped=${summary?.scopedInputCount ?? -1} reason=${reason}`,
      )
    }
    inputHandle = (await client.call<{ result?: { objectId?: string } }>("Runtime.callFunctionOn", {
      objectId: handle,
      functionDeclaration: "function() { return this.input }",
    })).result?.objectId
    if (!inputHandle) throw new Error("Active composer file input disappeared")
    const nodeId = (await client.call<{ nodeId?: number }>("DOM.requestNode", { objectId: inputHandle })).nodeId
    if (!nodeId) throw new Error("Active composer file input could not be resolved")
    const described = await client.call<{ node?: { backendNodeId?: number; attributes?: string[] } }>(
      "DOM.describeNode",
      { nodeId },
    )
    const attrs = new Map<string, string>()
    const values = described.node?.attributes ?? []
    for (let index = 0; index < values.length; index += 2) attrs.set(values[index]!, values[index + 1]!)
    if (attrs.get("type") !== "file" || attrs.get("disabled") !== undefined || attrs.get("aria-disabled") === "true")
      throw new Error("Active composer file input is no longer eligible")
    if (!described.node?.backendNodeId) throw new Error("Active composer input has no backend node identity")
    return {
      ...summary,
      nodeId,
      backendNodeId: described.node.backendNodeId,
      multiple: attrs.has("multiple"),
    }
  } finally {
    if (inputHandle) await client.call("Runtime.releaseObject", { objectId: inputHandle }).catch(() => {})
    await client.call("Runtime.releaseObject", { objectId: handle }).catch(() => {})
  }
}

async function promptSummary(client: CdpClient) {
  return client.evaluate<{
    url: string
    title: string
    editorCount: number
    editorTextLength: number
    attachmentLabels: string[]
    attachButton: boolean
    sendButton: boolean
    target: ResolverDiagnostics
  }>(`(() => {
    const visible = (${visible.toString()})
    const target = ${OPEN_CODE_COMPOSER_TARGET}
    const composer = target.composer
    const editor = target.editor
    const labels = [...(composer?.querySelectorAll('span.text-10-regular') ?? [])]
      .map((node) => (node.textContent ?? '').trim())
      .filter((text) => text && text.length < 260)
    return {
      url: location.href,
      title: document.title,
      editorCount: target.editorCount,
      editorTextLength: (editor?.innerText ?? editor?.value ?? '').length,
      attachmentLabels: [...new Set(labels)],
      attachButton: [...(composer?.querySelectorAll('[data-action="prompt-attach"]') ?? [])].some(visible),
      sendButton: [...(composer?.querySelectorAll('[data-action="prompt-submit"]') ?? [])].some(visible),
      target: {editorCount:target.editorCount,composerCount:target.composerCount,globalInputCount:target.globalInputCount,eligibleGlobalInputCount:target.eligibleGlobalInputCount,scopedInputCount:target.scopedInputCount,reason:target.reason}
    }
  })()`)
}

async function composerEditor(client: CdpClient) {
  const state = await client.evaluate<{ ok: boolean; reason?: string; editorCount?: number }>(`(() => {
    const target = ${OPEN_CODE_COMPOSER_TARGET}
    if (target.reason !== 'ok' || !target.editor) return {ok:false,reason:target.reason,editorCount:target.editorCount}
    target.editor.focus()
    if (target.editor.isContentEditable) {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(target.editor)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    return {ok:document.activeElement===target.editor,reason:target.reason,editorCount:target.editorCount}
  })()`)
  if (!state.ok) throw new Error(`Cannot focus the visible prompt editor: ${state.reason ?? "focus failed"}`)
}

async function clickElement(client: CdpClient, selector: string, scopeToComposer = true) {
  const point = await client.evaluate<{ x: number; y: number } | { error: string }>(`(() => {
    const target = ${OPEN_CODE_COMPOSER_TARGET}
    const root = ${scopeToComposer ? "target.editor?.closest('[data-prompt-composer]')" : "document"}
    if (!root) return {error:'No active composer'}
    const el = root.querySelector(${JSON.stringify(selector)})
    if (!el || !(${visible.toString()})(el)) return {error:'Visible control not found'}
    if (el instanceof HTMLButtonElement && (el.disabled || el.getAttribute('aria-disabled') === 'true')) return {error:'Control disabled'}
    el.scrollIntoView({block:'center',inline:'center'})
    const rect=el.getBoundingClientRect()
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}
  })()`)
  if ("error" in point) throw new Error(point.error)
  await client.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" })
  await client.call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 })
  await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 })
}

function fileChooserOpened(client: CdpClient, timeoutMs = 3000) {
  const socket = (client as unknown as { socket: WebSocket }).socket
  return new Promise<{ backendNodeId?: number }>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeEventListener("message", onMessage)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("Timed out waiting for Page.fileChooserOpened"))
    }, timeoutMs)
    const onMessage = (event: MessageEvent) => {
      let message: { method?: string; params?: { backendNodeId?: number } }
      try {
        message = JSON.parse(String(event.data)) as typeof message
      } catch {
        return
      }
      if (message.method !== "Page.fileChooserOpened") return
      cleanup()
      resolve({ backendNodeId: message.params?.backendNodeId })
    }
    socket.addEventListener("message", onMessage)
  })
}

async function waitForAttachmentLabels(client: CdpClient, names: string[], timeoutMs = 15000) {
  const expected = names.map((name) => path.basename(name))
  const deadline = Date.now() + timeoutMs
  let latest: string[] = []
  while (Date.now() < deadline) {
    const state = await promptSummary(client)
    latest = state.attachmentLabels
    if (expected.every((name) => latest.includes(name))) return latest
    await wait(200)
  }
  throw new Error(`Prompt attachment labels did not appear before timeout; visibleLabelCount=${latest.length}`)
}

async function attach(client: CdpClient, inputPaths: string[]) {
  if (!inputPaths.length) throw new Error("attach requires one or more file paths")
  const paths = inputPaths.map((value) => path.resolve(value))
  for (const file of paths) {
    if (!(await stat(file)).isFile()) throw new Error("Every attach path must name a regular file")
  }
  const before = await activeInput(client)
  if (paths.length > 1 && !before.multiple) throw new Error("Current composer file input does not accept multiple files")

  await client.call("Page.enable")
  await client.call("Page.setInterceptFileChooserDialog", { enabled: true })
  let chooser: Promise<{ backendNodeId?: number }> | undefined
  try {
    chooser = fileChooserOpened(client)
    await clickElement(client, '[data-action="prompt-attach"]')
    const event = await chooser
    if (event.backendNodeId && event.backendNodeId !== before.backendNodeId)
      throw new Error("File chooser opened from a different composer input")

    const current = await activeInput(client)
    if (current.backendNodeId !== before.backendNodeId)
      throw new Error("Active composer changed while file chooser was open")
    if (paths.length > 1 && !current.multiple) throw new Error("Current composer no longer accepts multiple files")
    await client.call("DOM.setFileInputFiles", { nodeId: current.nodeId, files: paths })
    const labels = await waitForAttachmentLabels(client, paths)
    return { fileCount: paths.length, chooserCaptured: true, visibleAttachmentCount: labels.length }
  } catch (error) {
    await chooser?.catch(() => {})
    throw error
  } finally {
    await client.call("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {})
  }
}

async function pasteFile(client: CdpClient, inputPath: string) {
  const file = path.resolve(inputPath)
  if (!(await stat(file)).isFile()) throw new Error("paste requires a regular file path")
  const id = `opencode-ui-paste-${randomUUID()}`
  const created = await client.evaluate<{ ok: boolean; reason?: string }>(`(() => {
    const target=${OPEN_CODE_COMPOSER_TARGET}
    if(target.reason!=='ok'||!target.editor)return {ok:false,reason:target.reason}
    const input=document.createElement('input')
    input.type='file';input.id=${JSON.stringify(id)};input.multiple=false
    input.style.cssText='position:fixed;left:-10000px;top:-10000px;width:1px;height:1px'
    document.body.append(input)
    return {ok:true}
  })()`)
  if (!created.ok) throw new Error(`Cannot paste into composer: ${created.reason ?? "no active editor"}`)
  try {
    await client.call("DOM.enable")
    const root = await client.call<{ root?: { nodeId?: number } }>("DOM.getDocument", { depth: -1 })
    if (!root.root?.nodeId) throw new Error("Page document is unavailable")
    const query = await client.call<{ nodeId?: number }>("DOM.querySelector", {
      nodeId: root.root.nodeId,
      selector: `#${id}`,
    })
    if (!query.nodeId) throw new Error("Temporary paste input disappeared")
    await client.call("DOM.setFileInputFiles", { nodeId: query.nodeId, files: [file] })
    const dispatch = await client.evaluate<{ ok: boolean; name?: string; reason?: string }>(`(() => {
      const target=${OPEN_CODE_COMPOSER_TARGET}
      const input=document.getElementById(${JSON.stringify(id)})
      if(target.reason!=='ok'||!target.editor)return {ok:false,reason:target.reason}
      const file=input instanceof HTMLInputElement ? input.files?.[0] : undefined
      if(!file)return {ok:false,reason:'selected file unavailable'}
      const transfer=new DataTransfer();transfer.items.add(file)
      const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true})
      if(!event.clipboardData)Object.defineProperty(event,'clipboardData',{value:transfer})
      target.editor.dispatchEvent(event)
      return {ok:event.defaultPrevented,name:file.name}
    })()`)
    if (!dispatch.ok) throw new Error(`Paste event was not accepted: ${dispatch.reason ?? "unknown reason"}`)
    const labels = await waitForAttachmentLabels(client, [path.basename(file)])
    return { pasted: true, visibleAttachmentCount: labels.length }
  } finally {
    await client.evaluate(`document.getElementById(${JSON.stringify(id)})?.remove()`).catch(() => {})
  }
}

async function mention(client: CdpClient, rawQuery: string) {
  const query = rawQuery.trim().replace(/^@/, "")
  if (!query) throw new Error("mention requires a query")
  await composerEditor(client)
  await client.call("Input.insertText", { text: `@${query}` })
  const deadline = Date.now() + 10000
  let point: { x: number; y: number } | undefined
  while (Date.now() < deadline) {
    point = await client.evaluate<{ x: number; y: number } | undefined>(`(() => {
      const target=${OPEN_CODE_COMPOSER_TARGET}
      const root=target.editor?.closest('[data-prompt-composer]')
      if(!root)return
      const visible=(${visible.toString()})
      const matches=(${mentionCandidateMatches.toString()})
      const needle=${JSON.stringify(query.toLowerCase())}
      const button=[...root.querySelectorAll('button')].find((el)=>{
        const label=(el.innerText||el.getAttribute('aria-label')||'').trim().toLowerCase()
        return visible(el)&&el.closest('div.absolute.inset-x-0')&&matches(label,needle)
      })
      if(!button)return
      button.scrollIntoView({block:'center',inline:'center'})
      const rect=button.getBoundingClientRect()
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}
    })()`)
    if (point) break
    await wait(100)
  }
  if (!point) throw new Error(`No visible mention-menu button matched queryLength=${query.length}`)
  await client.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" })
  await client.call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 })
  await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 })
  const tokenDeadline = Date.now() + 10000
  let selected: { type: "file" | "agent"; nameLength: number } | undefined
  while (Date.now() < tokenDeadline) {
    selected = await client.evaluate<{ type: "file" | "agent"; nameLength: number } | undefined>(`(() => {
      const target=${OPEN_CODE_COMPOSER_TARGET}
      if(target.reason!=='ok'||!target.editor)return
      const needle=${JSON.stringify(query.toLowerCase())}
      const matches=(${mentionTokenMatches.toString()})
      const token=[...target.editor.querySelectorAll('[data-type="file"][data-path], [data-type="agent"][data-name]')].find((el)=>{
        const type=el.getAttribute('data-type')||''
        const name=type==='file'?el.getAttribute('data-path')||'':el.getAttribute('data-name')||''
        return matches(type,name,needle)
      })
      return token?{type:token.getAttribute('data-type'),nameLength:(token.getAttribute('data-path')||token.getAttribute('data-name')||'').length}:undefined
    })()`)
    if (selected) break
    await wait(100)
  }
  if (!selected) throw new Error(`Mention candidate click did not produce a matching editor token; queryLength=${query.length}`)
  return { selected: true, kind: selected.type, queryLength: query.length, tokenNameLength: selected.nameLength }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(
      [
        "Already-running OpenCode Dev renderer UI helper (no sidecar/API calls).",
        "Commands: inspect | focus | type <text> | mention <query> | attach <path...> | paste <path> | send | screenshot [path]",
      ].join("\n") + "\n",
    )
    return
  }
  const { client, target } = await connectCdp(endpoint)
  if (!target.url.includes("localhost:5173") && !target.url.startsWith("oc://")) {
    client.close()
    throw new Error("CDP target is not the OpenCode development renderer")
  }
  try {
    let result: unknown
    if (command === "inspect") result = await promptSummary(client)
    else if (command === "focus") {
      await composerEditor(client)
      result = { focused: true }
    } else if (command === "type") {
      const text = args.join(" ")
      if (!text) throw new Error("type requires text")
      await composerEditor(client)
      await client.call("Input.insertText", { text })
      result = { typedChars: text.length }
    } else if (command === "mention") {
      result = await mention(client, args.join(" "))
    } else if (command === "attach") {
      result = await attach(client, args)
    } else if (command === "paste") {
      if (args.length !== 1) throw new Error("paste requires exactly one file path")
      result = await pasteFile(client, args[0]!)
    } else if (command === "send") {
      const ready = await client.evaluate<boolean>(openCodeSendReadyExpression())
      if (!ready) throw new Error("Visible prompt send button is unavailable, disabled, or currently a stop control")
      await clickElement(client, '[data-action="prompt-submit"]')
      result = { clicked: "prompt-submit" }
    } else if (command === "screenshot") {
      const output = path.resolve(args[0] ?? path.join("/tmp", `opencode-ui-${Date.now()}.png`))
      await client.call("Page.enable")
      const shot = await client.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
      await Bun.write(output, Buffer.from(shot.data, "base64"))
      result = { screenshot: output }
    } else throw new Error(`Unknown command: ${command}`)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    client.close()
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
