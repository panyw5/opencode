import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const log = (text: string) => console.log(`[question-response-test] ${text}`)
const source = `/@fs${resolve(import.meta.dir, "../../app/src")}`
const baseline = process.argv.includes("--baseline")

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/(localhost|127\.0\.0\.1):\d+\//)
  const root = await realpath(await mkdtemp("/tmp/opencode-question-response-"))
  let directory = root
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const previousTab = await cdp.evaluate<{ directory: string; sessionID: string } | null>(`(() => {
    const tab = document.querySelector('[data-component="session-tab"][data-active="true"]');
    return tab ? {directory:tab.dataset.directory,sessionID:tab.dataset.sessionId} : null;
  })()`)
  const previous = previousTab
    ? `/${Buffer.from(previousTab.directory).toString("base64url")}/session/${previousTab.sessionID}`
    : "/"
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
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${response.ok ? "" : await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  const wait = async (label: string, expression: string) => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await cdp.evaluate<boolean>(expression)) return
      await Bun.sleep(40)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const navigate = (route: string) =>
    cdp.evaluate(
      `window.__questionResponseNavigation = import(${JSON.stringify(`${source}/utils/notification-click.ts`)}).then(m => { m.handleNotificationClick(${JSON.stringify(route)}); return true })`,
    )
  const sessions: { id: string; directory: string }[] = []
  try {
    await cdp.evaluate(`(() => {
      const qa = window.__questionResponseQA = { fetch: window.fetch, logs: [], debug: console.debug, warn: console.warn, active: false };
      for (const level of ['debug','warn']) console[level] = (...args) => {
        qa.logs.push(args.map(String).join(' ')); qa[level](...args);
      };
      window.fetch = async (...args) => {
        const input=args[0], url=new URL(input instanceof Request ? input.url : String(input),location.href);
        if (!qa.active || !url.pathname.includes('/question/'+qa.id+'/')) return qa.fetch.apply(window,args);
        qa.calls++; qa.dispatched=performance.now()-qa.started;
        await new Promise(resolve=>setTimeout(resolve,600));
        if (qa.fail) { qa.failed=true; return new Response(JSON.stringify({message:'QA unavailable'}),{status:503,headers:{'Content-Type':'application/json'}}); }
        const response=await qa.fetch.apply(window,args);
        if (qa.lateFailure) {
          await new Promise(resolve=>setTimeout(resolve,200));qa.failed=true;
          return new Response(JSON.stringify({message:'QA response lost after settlement'}),{status:503,headers:{'Content-Type':'application/json'}});
        }
        qa.done=true; qa.status=response.status; return response;
      };
    })()`)
    for (const action of (baseline ? ["reply", "reject"] : ["reply", "reject", "failure", "settled-error"]) as (
      | "reply"
      | "reject"
      | "failure"
      | "settled-error"
    )[]) {
      directory = await realpath(await mkdtemp(`${root}/case-`))
      const session = await request("/session", "POST", { title: `QA question response ${action}` })
      sessions.push({ id: session.id, directory })
      await request(`/session/${session.id}/shell`, "POST", {
        agent: "build",
        command: "printf QUESTION_RESPONSE_SIDECAR_OK",
      })
      const messages = await request(`/session/${session.id}/message`)
      const tool = messages.flatMap((row: any) => row.parts).find((part: any) => part.type === "tool")
      assert.ok(tool?.state.output.includes("QUESTION_RESPONSE_SIDECAR_OK"))
      log(`PASS ${action}: sent shell message and verified sidecar reply`)
      const question = {
        id: `que_latency_${Date.now()}`,
        sessionID: session.id,
        questions: [
          {
            header: "QA",
            question: "Check immediate question response",
            options: [{ label: "Answer A", description: "Answer" }],
          },
        ],
        tool: { messageID: tool.messageID, callID: tool.callID },
      }
      await request(`/session/${session.id}/message/${tool.messageID}/part/${tool.id}`, "PATCH", {
        ...tool,
        tool: "question",
        state: {
          status: "running",
          input: { questions: question.questions },
          time: { start: Date.now() },
          metadata: { questionRequest: question },
        },
      })
      assert.ok((await request("/question")).some((item: any) => item.id === question.id))
      await navigate(`/${Buffer.from(directory).toString("base64url")}/session/${session.id}`)
      await wait(
        "question dock",
        `document.querySelector('[data-component="session-page"]')?.dataset.sessionId===${JSON.stringify(session.id)} && !!document.querySelector('[data-slot="question-footer-actions"]')`,
      )
      await wait(
        "dock fully open",
        `(() => { const dock=document.querySelector('[data-kind="question"]'); return dock && Number(getComputedStyle(dock.parentElement.parentElement).opacity)>0.99 })()`,
      )
      await cdp.evaluate(`(() => {
        const qa=window.__questionResponseQA;
        Object.assign(qa,{active:true,id:${JSON.stringify(question.id)},fail:${action === "failure"},lateFailure:${action === "settled-error"},failed:false,done:false,calls:0,frames:[],started:performance.now(),sampling:true});
        const dock=document.querySelector('[data-kind="question"]'), exit=dock.parentElement.parentElement;
        const sample=()=>{
          if(!qa.sampling)return;
          qa.frames.push({at:performance.now()-qa.started,opacity:Number(getComputedStyle(exit).opacity),connected:exit.isConnected});
          requestAnimationFrame(sample);
        };
        const buttons=[...document.querySelectorAll('[data-slot="question-footer-actions"] button')];
        ${action === "reply" || action === "failure" ? `document.querySelector('[data-slot="question-option-wrap"] button').click();` : ""}
        const button=${action === "reply" ? "buttons.at(-1)" : "buttons[0]"};
        button.click();button.click();requestAnimationFrame(sample);
      })()`)
      await wait("response completed", "window.__questionResponseQA.done || window.__questionResponseQA.failed")
      if (action === "settled-error") {
        await wait(
          "late error handled",
          `window.__questionResponseQA.logs.some(line=>line.includes('[question-response] restore id=${question.id} '))`,
        )
      }
      if (action === "failure") {
        assert.equal(
          await cdp.evaluate(
            `document.querySelector('[data-slot="question-option"][data-picked="true"]')?.textContent.includes('Answer A')`,
          ),
          true,
          "failed dismissal must preserve the selected answer",
        )
        await wait(
          "failed question restored",
          `!!document.querySelector('[data-slot="question-footer-actions"] button:not(:disabled)')`,
        )
      } else {
        await wait("dock removed", `!document.querySelector('[data-kind="question"]')`)
      }
      const result = await cdp.evaluate<{
        calls: number
        frames: { at: number; opacity: number; connected: boolean }[]
        logs: string[]
      }>(`(() => {
        const qa=window.__questionResponseQA;qa.sampling=false;qa.active=false;
        return {calls:qa.calls,frames:qa.frames,logs:qa.logs};
      })()`)
      assert.equal(result.calls, 1, "double clicks must submit exactly once")
      const first = result.frames.find((frame) => !frame.connected || frame.opacity < 0.99)
      assert.ok(first, "exit animation must start")
      log(`${action}: click-to-exit=${first.at.toFixed(1)}ms (network delayed 600ms)`)
      if (!baseline) assert.ok(first.at < 250, `animation waited for backend: ${first.at}ms`)
      if (action === "failure") {
        assert.ok((await request("/question")).some((item: any) => item.id === question.id))
        // Retry after the original dock has unmounted; the mutation error must still restore it.
        await cdp.evaluate(
          `(() => { const qa=window.__questionResponseQA;qa.active=true;qa.fail=false;qa.done=false;document.querySelector('[data-slot="question-footer-actions"] button').click() })()`,
        )
        await wait("retry completed", "window.__questionResponseQA.done")
        await wait("retry dock removed", `!document.querySelector('[data-kind="question"]')`)
        await cdp.evaluate("window.__questionResponseQA.active=false")
        log("PASS rejection failure restores dock; retry succeeds")
      }
      const final = (await request(`/session/${session.id}/message`))
        .flatMap((row: any) => row.parts)
        .find((part: any) => part.id === tool.id)
      assert.equal(final.state.status, action === "reply" ? "completed" : "error")
      assert.ok(!(await request("/question")).some((item: any) => item.id === question.id))
      log(`PASS ${action}: verified backend terminal state and question removal`)
    }
    log(
      await cdp.evaluate<string>(
        "window.__questionResponseQA.logs.filter(line=>line.includes('[question-')).join('\\n')",
      ),
    )
  } finally {
    await cdp.evaluate(`(() => {
      const qa=window.__questionResponseQA;if(!qa)return;
      qa.sampling=false;window.fetch=qa.fetch;console.debug=qa.debug;console.warn=qa.warn;delete window.__questionResponseQA;
    })()`)
    await navigate(previous)
    for (const item of sessions) {
      directory = item.directory
      await request(`/session/${item.id}`, "DELETE")
    }
    await rm(root, { recursive: true, force: true })
    log("restored previous session; removed owned test data")
  }
})
