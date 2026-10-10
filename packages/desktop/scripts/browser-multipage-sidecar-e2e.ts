import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { CdpClient, connectCdp, listTargets } from "./cdp"

const output = await mkdtemp(join(tmpdir(), "opencode-agent-pages-e2e-"))
await mkdir(join(output, "project"))
const directory = await realpath(join(output, "project"))
const { client, target } = await connectCdp()
if (!target.url.includes("localhost:5173") && !target.url.startsWith("oc://")) {
  client.close()
  throw new Error("Only the development renderer may run this integration test")
}
const log = (message: string) => console.log(`[browser-multipage-sidecar-e2e] ${message}`)
const cases: Array<{ id: string; marker: string; url: string }> = []
try {
  await client.evaluate(`(async()=>{
    const sidecar=await window.api.awaitInitialization(()=>{})
    window.__agentPagesRequest=async(path,body)=>{
      const response=await fetch(sidecar.url+path,{
        method:body===undefined?'GET':'POST',
        headers:{'Content-Type':'application/json','x-opencode-directory':encodeURIComponent(${JSON.stringify(directory)}),Authorization:'Basic '+btoa((sidecar.username||'opencode')+':'+sidecar.password)},
        body:body===undefined?undefined:JSON.stringify(body),
      })
      if(!response.ok)throw Error('sidecar HTTP '+response.status+' path='+path)
      return response.status===204?null:response.json()
    }
    const providers=await window.__agentPagesRequest('/provider')
    if(!providers.connected.includes('axonhub-codex')||!providers.all.find(p=>p.id==='axonhub-codex')?.models['gpt-6-luna'])
      throw Error('The requested GPT-6-Luna test provider is not available; no fallback model selected')
  })()`)
  for (const label of ["A", "B"]) {
    const marker = `MPL_AGENT_${label}_${randomUUID().replaceAll("-", "").slice(0, 10)}`
    const html = `<!doctype html><title>Agent page ${label}</title><button onclick="window.count++;document.querySelector('[data-counter]').textContent='${marker}='+window.count">Increment once</button><h1 data-counter>${marker}=0</h1><script>window.count=0</script>`
    const url = `data:text/html,${encodeURIComponent(html)}`
    const session = await client.evaluate<{ id: string }>(`window.__agentPagesRequest('/session',{
      title:${JSON.stringify(`Multipage browser sidecar test ${label}`)},
      permission:[{permission:'*',pattern:'*',action:'allow'}],
    })`)
    cases.push({ id: session.id, marker, url })
  }
  await writeFile(join(output, "run.json"), JSON.stringify({ directory, cases }, null, 2), { mode: 0o600 })
  log(`dispatching two real GPT-6-Luna agent requests manifest=${join(output, "run.json")}`)
  await client.evaluate(`Promise.all(${JSON.stringify(cases)}.map(test=>window.__agentPagesRequest('/session/'+test.id+'/prompt_async',{
    agent:'build',model:{providerID:'axonhub-codex',modelID:'gpt-6-luna'},
    parts:[{type:'text',text:'Use only browser_navigate, browser_read, and browser_click for this test. Navigate your own browser to '+test.url+' . Read the page, click the button labeled Increment once exactly once, and read again. Return only the exact current heading text after the click. Use the live heading evidence, not the original URL HTML. Do not infer the answer; perform the browser actions. Do not ask questions or operate another session page.'}],
  })))`)
  let previous = ""
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    const observations = await client.evaluate<
      Array<{ tools: Array<{ name: string; status: string }>; answered: boolean; finished: boolean }>
    >(`Promise.all(${JSON.stringify(cases)}.map(async test=>{
      const messages=await window.__agentPagesRequest('/session/'+test.id+'/message')
      const tools=messages.flatMap(m=>m.parts).filter(p=>p.type==='tool').map(p=>({name:p.tool,status:p.state.status}))
      const texts=messages.filter(m=>m.info.role==='assistant').flatMap(m=>m.parts).filter(p=>p.type==='text').map(p=>p.text)
      const last=messages.filter(m=>m.info.role==='assistant').at(-1)
      return {tools,answered:texts.some(text=>text.includes(test.marker+'=1')),finished:last?.info.finish==='stop'}
    }))`)
    const summary = observations
      .map(
        (observation, index) =>
          `${index ? "B" : "A"}:tools=${observation.tools.map((tool) => `${tool.name}:${tool.status}`).join(",")} answered=${observation.answered}`,
      )
      .join(" ")
    if (summary !== previous) {
      log(summary)
      previous = summary
    }
    if (observations.some((observation) => observation.finished && !observation.answered))
      throw new Error("The agent finished without returning the live post-click heading; received message validation failed")
    if (observations.every((observation) => observation.answered)) {
      const views = await client.evaluate<Array<{ pageID?: string; partition: string; profileID?: string }>>(
        "window.api.browser.getState()",
      )
      const pages = cases.map((test) =>
        views.find((view) => (view.pageID ?? view.partition) === `agent-browser-${test.id}`),
      )
      if (!pages.every(Boolean) || pages[0]!.pageID === pages[1]!.pageID || pages[0]!.profileID === pages[1]!.profileID)
        throw new Error("Ordinary agent browser pages/profiles were not independently isolated")
      for (const [index, test] of cases.entries()) {
        const tools = observations[index].tools
        if (
          !["browser_navigate", "browser_click"].every((name) =>
            tools.some((tool) => tool.name === name && tool.status === "completed"),
          ) ||
          tools.filter((tool) => tool.name === "browser_read" && tool.status === "completed").length < 2
        )
          throw new Error("The agent did not perform and complete the required browser operations")
        const matches = (await listTargets()).filter((target) => target.url === test.url)
        if (matches.length !== 1) throw new Error("The local test page did not resolve to a unique native target")
        const page = await CdpClient.connect(matches[0].webSocketDebuggerUrl)
        try {
          const evidence = await page.evaluate<{ count: number; status: string; width: number; visible: string }>(
            "({count:window.count,status:document.querySelector('[data-counter]').textContent,width:innerWidth,visible:document.visibilityState})",
          )
          if (evidence.count !== 1 || evidence.status !== `${test.marker}=1` || evidence.width < 100)
            throw new Error("Actual page counter differs from the owning agent's received answer")
          log(
            `verified agent=${test.id} page=${pages[index]!.pageID} count=1 width=${evidence.width} visibility=${evidence.visible}`,
          )
        } finally {
          page.close()
        }
      }
      await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, directory, cases, pages }, null, 2), {
        mode: 0o600,
      })
      log(`PASS independent real sidecar agent browser actions and received messages verified artifacts=${output}`)
      break
    }
    if (Date.now() + 2000 >= deadline)
      throw new Error("Agent browser integration timed out; requests were not repeated")
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
} finally {
  for (const test of cases) {
    await client
      .evaluate(`window.__agentPagesRequest('/session/'+${JSON.stringify(test.id)}+'/abort',{})`)
      .catch(() => {})
    await client.evaluate(`window.api.browser.close(${JSON.stringify(`agent-browser-${test.id}`)})`).catch(() => {})
  }
  client.close()
}
