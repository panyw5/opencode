import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { DEFAULT_THEMES } from "../../ui/src/theme/default-themes"
import { resolveThemeVariant } from "../../ui/src/theme/resolve"
import { withCdp } from "./cdp"

const log = (message: string) => console.log(`[question-custom-test] ${message}`)
const source = `/@fs${resolve(import.meta.dir, "../../app/src")}`

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const directory = await realpath(await mkdtemp("/tmp/opencode-question-custom-"))
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const previous = await cdp.evaluate<string>(`(() => {
    const tab = document.querySelector('[data-component="session-tab"][data-active="true"]');
    if (!tab) return '/';
    return '/' + btoa(tab.dataset.directory).replaceAll('+','-').replaceAll('/','_').replaceAll('=','') + '/session/' + tab.dataset.sessionId;
  })()`)
  const request = async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(connection.url + path, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  const wait = async (label: string, expression: string) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await cdp.evaluate<boolean>(expression)) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const navigate = (route: string) =>
    cdp.evaluate(`(() => { window.__questionCustomQANavigation = (async () => {
    const {handleNotificationClick} = await import(${JSON.stringify(`${source}/utils/notification-click.ts`)});
    handleNotificationClick(${JSON.stringify(route)});
  })(); return true })()`)
  const click = async (selector: string) => {
    await cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}));
      el.click();
    })()`)
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 })
  }
  const state = () =>
    cdp.evaluate<{ picked: string; focused: string; background: string }[]>(`[
    ...document.querySelectorAll('[data-slot="question-option"]')
  ].map(el=>({picked:el.dataset.picked,focused:el.dataset.focused,background:getComputedStyle(el).backgroundColor}))`)
  let sessionID: string | undefined
  try {
    const session = await request("/session", "POST", { title: "QA custom answer selection" })
    sessionID = session.id
    await request(`/session/${sessionID}/shell`, "POST", {
      agent: "build",
      command: "printf QUESTION_CUSTOM_SELECTION_OK",
    })
    const messages = await request(`/session/${sessionID}/message`)
    assert.ok(
      messages.some((row: any) =>
        row.parts.some(
          (part: any) =>
            part.type === "tool" &&
            part.state.status === "completed" &&
            part.state.output.includes("QUESTION_CUSTOM_SELECTION_OK"),
        ),
      ),
    )
    log("PASS sidecar message sent and completed reply received")
    const question = {
      id: `que_custom_${Date.now()}`,
      sessionID,
      questions: [
        {
          question: "QA custom selection",
          header: "QA",
          options: [
            { label: "Ordinary A", description: "First option" },
            { label: "Ordinary B", description: "Second option" },
          ],
        },
      ],
    }
    await cdp.evaluate(`(() => {
      window.__questionCustomQA = {fetch:window.fetch,requests:[],style:document.documentElement.getAttribute('style'),theme:document.documentElement.dataset.theme,scheme:document.documentElement.dataset.colorScheme};
      window.fetch = async (...args) => {
        const req = new Request(args[0], args[1]);
        const url = new URL(req.url);
        const dir = url.searchParams.get('directory') ?? decodeURIComponent(req.headers.get('x-opencode-directory') ?? '');
        window.__questionCustomQA.requests.push(url.href+' directory='+dir);
        if (url.pathname !== '/question' || dir !== ${JSON.stringify(directory)}) return window.__questionCustomQA.fetch(...args);
        window.__questionCustomQA.requests.push('injected question for '+${JSON.stringify(sessionID)});
        return new Response(JSON.stringify([${JSON.stringify(question)}]), {status:200,headers:{'Content-Type':'application/json'}});
      };
      const style = document.createElement('style');
      style.id = 'question-custom-qa-style';
      style.textContent = '[data-kind="question"] [data-slot="question-option"] {transition:none !important}';
      document.head.append(style);
    })()`)
    await navigate(`/${Buffer.from(directory).toString("base64url")}/session/${sessionID}`)
    await wait(
      "owned question dock",
      `document.querySelector('[data-component="session-page"]')?.dataset.sessionId===${JSON.stringify(sessionID)} && document.querySelectorAll('[data-slot="question-option"]').length===3`,
    )
    for (const id of ["claude", "arc", "aether", "opencode"] as const) {
      const tokens = resolveThemeVariant(DEFAULT_THEMES[id].dark, true)
      await cdp.evaluate(`((tokens,id) => {
        const root=document.documentElement;
        for (const [key,value] of Object.entries(tokens)) root.style.setProperty('--'+key,value);
        root.style.colorScheme='dark';root.dataset.theme=id;root.dataset.colorScheme='dark';
      })(${JSON.stringify(tokens)},${JSON.stringify(id)})`)
      await click('[data-slot="question-option-wrap"] button')
      const resting = await state()
      assert.equal(resting[0].picked, "true", `${id}: ordinary option click selects it`)
      assert.equal(resting[2].picked, "false")
      assert.equal(
        resting[2].background,
        resting[1].background,
        `${id}: empty custom answer must use ordinary unselected fill`,
      )
      await cdp.evaluate(
        "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}))",
      )
      assert.equal((await state())[2].focused, "true", `${id}: keyboard navigation still reaches custom answer`)
      await click('[data-slot="question-option-wrap"] button')
      assert.ok(
        (await state()).every((option) => option.focused === "false"),
        `${id}: pointer selection clears stale keyboard focus`,
      )
      log(`PASS ${id}: empty custom answer is neutral; pointer clears old keyboard focus`)
      await click('[data-slot="question-option"][data-custom="true"] [data-slot="option-label"]')
      await wait("custom textarea", "document.activeElement?.matches('[data-slot=question-custom-input]')")
      await cdp.call("Input.insertText", { text: "QA typed custom answer" })
      const typed = await state()
      assert.equal(typed[2].picked, "true")
      assert.equal(
        typed[2].background,
        resting[0].background,
        `${id}: typed custom answer must use ordinary selected fill`,
      )
      await click('[data-slot="question-option-wrap"] button')
      const switched = await state()
      assert.equal(switched[2].picked, "false")
      assert.equal(switched[2].background, switched[1].background, `${id}: switching away removes custom highlight`)
      await cdp.evaluate(`(() => {
        const menu=document.createElement('div');menu.setAttribute('role','listbox');document.body.append(menu);
        menu.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));menu.remove();
        const event=new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true});event.preventDefault();document.body.dispatchEvent(event);
      })()`)
      assert.ok(
        (await state()).every((option) => option.focused === "false"),
        `${id}: menus and handled key events cannot focus question options`,
      )
      log(`PASS ${id}: empty, keyboard focus, pointer choice, typed selection and switching away`)
      await click('[data-slot="question-option"][data-custom="true"] [data-slot="option-label"]')
      await wait("reset custom textarea", "document.activeElement?.matches('[data-slot=question-custom-input]')")
      await cdp.evaluate(`(() => {
        const input=document.querySelector('[data-slot="question-custom-input"]');
        input.value='';input.dispatchEvent(new InputEvent('input',{bubbles:true}));
      })()`)
      await click('[data-slot="question-option-wrap"] button')
    }
  } catch (error) {
    log(
      await cdp.evaluate<string>("window.__questionCustomQA?.requests.join('\\n') ?? 'no frontend requests captured'"),
    )
    throw error
  } finally {
    await cdp.evaluate(`(() => {
      const saved=window.__questionCustomQA;if(!saved)return;
      window.fetch=saved.fetch;
      const root=document.documentElement;
      if(saved.style===null)root.removeAttribute('style');else root.setAttribute('style',saved.style);
      root.dataset.theme=saved.theme;root.dataset.colorScheme=saved.scheme;
      document.getElementById('question-custom-qa-style')?.remove();delete window.__questionCustomQA;
    })()`)
    await navigate(previous)
    if (sessionID) await request(`/session/${sessionID}`, "DELETE")
    await rm(directory, { recursive: true, force: true })
    log("restored previous session and theme; removed owned test session")
  }
})
