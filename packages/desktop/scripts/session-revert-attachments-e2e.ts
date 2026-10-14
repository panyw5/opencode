import { withCdp } from "./cdp"
import { fileURLToPath } from "node:url"

const directory = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "")
const log = (value: string) => console.log(`[revert-attachments-e2e] ${value}`)

function pdf() {
  const stream = "BT /F1 12 Tf 48 720 Td (REVERT_CACHE_PDF_FIXTURE) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = body.length
  body += `xref\n0 6\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`
  return `${body}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Expected the development renderer")
  const origin = new URL(target.url).origin
  const navigation = `${origin}/@fs${fileURLToPath(new URL("../../app/src/utils/notification-click.ts", import.meta.url))}`
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization()",
  )
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${connection.url}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  const session = await request("/session", "POST", { title: "QA attachment revert cache" })
  const previousScope = await cdp.evaluate<string | undefined>(
    "document.querySelector('[data-prompt-scope]')?.getAttribute('data-prompt-scope')",
  )
  log(`created sid=${session.id}`)
  const route = `/${Buffer.from(directory).toString("base64url")}/session/${session.id}`
  const wait = async (label: string, predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 120; i++) {
      if (await predicate()) return
      await Bun.sleep(250)
    }
    throw new Error(`Timed out: ${label}`)
  }
  try {
    await cdp.evaluate(`(() => {
    void import(${JSON.stringify(navigation)}).then(m=>m.handleNotificationClick(${JSON.stringify(route)}));
    return true;
  })()`)
    await wait("composer", () =>
      cdp.evaluate(
        `!!document.querySelector('[data-component=session-page][data-session-id="${session.id}"] [data-component=prompt-input]')`,
      ),
    )
    log("composer ready")
    await cdp.evaluate(`(() => {
    const button=[...document.querySelectorAll('[data-prompt-composer] button.prompt-pick')].find(e=>(e.innerText.trim()==='选择模型'||e.innerText.includes(' / ')) && e.getBoundingClientRect().width>0);
    button?.click();
  })()`)
    await wait("model selector", () =>
      cdp.evaluate("!!document.querySelector('button[data-key=\"axonhub-codex:gpt-6.1-sol\"]')"),
    )
    await cdp.evaluate("document.querySelector('button[data-key=\"axonhub-codex:gpt-6.1-sol\"]').click()")
    // Exercise the real prompt submit path, including its optimistic cache.
    await cdp.evaluate(`(() => {
    const editor=document.querySelector('[data-component=prompt-input]');
    const transfer=new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(pdf())}], 'revert-cache.pdf', {type:'application/pdf'}));
    editor.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));
    editor.focus();
  })()`)
    await wait("PDF attached", () => cdp.evaluate("document.body.innerText.includes('revert-cache.pdf')"))
    await cdp.call("Input.insertText", {
      text: "Reply with exactly REVERT_CACHE_FIRST_OK. Do not use tools or read the attached PDF.",
    })
    // Keep attachment acceptance deterministic even when the model gateway
    // does not support PDF input. The second turn exercises a real model reply.
    await cdp.evaluate(`(() => {
    const original=window.fetch;
    window.__revertAttachmentFetch=original;
    window.fetch=async (input,init)=>{
      const request=new Request(input,init);
      if(new URL(request.url).pathname==='/session/${session.id}/prompt_async'){
        window.fetch=original;
        const body=await request.clone().json();
        return original(new Request(request,{body:JSON.stringify({...body,noReply:true})}));
      }
      return original(input,init);
    };
  })()`)
    await wait("send enabled", () => cdp.evaluate("!!document.querySelector('button[aria-label=发送]:not(:disabled)')"))
    await cdp.evaluate("document.querySelector('button[aria-label=发送]').click()")
    let firstID = ""
    await wait("first user persisted", async () => {
      const rows = await request(`/session/${session.id}/message`)
      firstID = rows.find((row: any) => row.info.role === "user")?.info.id ?? ""
      return !!firstID
    })
    const first = (await request(`/session/${session.id}/message`)).find((row: any) => row.info.id === firstID)
    if (!first.parts.some((part: any) => part.type === "file" && part.mime === "application/pdf")) {
      throw new Error("PDF was not received by the sidecar")
    }
    log(`sidecar received PDF sid=${session.id} message=${firstID}`)
    await wait("rollback action", () =>
      cdp.evaluate("!!document.querySelector('button[aria-label=重置到此点]:not(:disabled)')"),
    )
    await cdp.evaluate("document.querySelector('button[aria-label=重置到此点]').click()")
    await wait("revert stored", async () => (await request(`/session/${session.id}`)).revert?.messageID === firstID)
    await wait("first bubble hidden", () => cdp.evaluate(`!document.querySelector('#message-${firstID}')`))
    log("rollback hides first message without reload")
    await cdp.evaluate("document.querySelector('button[aria-label=移除附件]')?.click()")
    await cdp.evaluate(`(() => {
    const editor=document.querySelector('[data-component=prompt-input]');
    editor.focus();
    const selection=getSelection();
    const range=document.createRange();range.selectNodeContents(editor);
    selection.removeAllRanges();selection.addRange(range);
  })()`)
    await cdp.call("Input.insertText", { text: "Reply with exactly REVERT_CACHE_SECOND_OK. Do not use tools." })
    await wait("second send enabled", () =>
      cdp.evaluate(
        "!!document.querySelector('button[aria-label=发送]:not(:disabled),button[aria-label^=发送干预]:not(:disabled)')",
      ),
    )
    await cdp.evaluate("document.querySelector('button[aria-label=发送],button[aria-label^=发送干预]').click()")
    await wait("cleanup persisted", async () => {
      const rows = await request(`/session/${session.id}/message`)
      return !rows.some((row: any) => row.info.id === firstID) && rows.some((row: any) => row.info.role === "user")
    })
    await wait("second reply", async () => {
      const rows = await request(`/session/${session.id}/message`)
      return rows.some(
        (row: any) =>
          row.info.role === "assistant" &&
          row.parts.some((part: any) => part.type === "text" && part.text.includes("REVERT_CACHE_SECOND_OK")),
      )
    })
    await Bun.sleep(1500)
    const present = await cdp.evaluate<boolean>(`!!document.querySelector('#message-${firstID}')`)
    if (present) throw new Error("Deleted first message was resurrected")
    log("PASS second reply received; deleted first message stays absent without reload")
  } finally {
    await cdp.evaluate(
      "(()=>{if(window.__revertAttachmentFetch)window.fetch=window.__revertAttachmentFetch;return true})()",
    )
    await request(`/session/${session.id}`, "DELETE")
    if (previousScope) {
      const [previousDirectory, previousID] = JSON.parse(previousScope)
      if (previousDirectory && previousID) {
        const previousRoute = `/${Buffer.from(previousDirectory).toString("base64url")}/session/${previousID}`
        await cdp.evaluate(
          `(()=>{void import(${JSON.stringify(navigation)}).then(m=>m.handleNotificationClick(${JSON.stringify(previousRoute)}));return true})()`,
        )
      }
    }
    log("owned test session cleaned")
  }
})
