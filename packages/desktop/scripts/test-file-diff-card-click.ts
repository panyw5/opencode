import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const log = (text: string) => console.log(`[file-diff-card-click-test] ${text}`)
const source = `/@fs${resolve(import.meta.dir, "../../app/src")}`

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const directory = await realpath(await mkdtemp("/tmp/opencode-diff-card-click-"))
  const file = "changed file.txt"
  const absolute = `${directory}/${file}`
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const previous = new URL(target.url).pathname + new URL(target.url).search
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
  const wait = async (label: string, check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await check()) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const navigate = (route: string) =>
    cdp.evaluate(`(() => { window.__diffClickNavigation = (async () => {
      const { handleNotificationClick } = await import(${JSON.stringify(`${source}/utils/notification-click.ts`)});
      handleNotificationClick(${JSON.stringify(route)});
    })(); return true })()`)
  let sessionID: string | undefined
  try {
    const session = await request("/session", "POST", { title: "QA diff card modifier clicks" })
    sessionID = session.id
    const marker = "FILE_DIFF_CARD_CLICK_SIDECAR_OK"
    await request(`/session/${sessionID}/shell`, "POST", {
      agent: "build",
      command: `printf ${marker} | tee '${file}'`,
    })
    const messages = await request(`/session/${sessionID}/message`)
    assert.ok(messages.some((row: any) => row.info.role === "user"))
    assert.ok(
      messages.some(
        (row: any) =>
          row.info.role === "assistant" &&
          row.parts.some(
            (part: any) =>
              part.type === "tool" && part.state.status === "completed" && part.state.output.includes(marker),
          ),
      ),
      "Sidecar must return the completed shell reply",
    )
    log("PASS real sidecar message sent and reply received")

    // Inject diffs only into the owned test session's frontend snapshot.
    await cdp.evaluate(`(() => {
      window.__diffClickOriginalFetch = window.fetch;
      window.__diffClickOriginalDebug = console.debug;
      window.__diffClickLogs = [];
      console.debug = (...args) => {
        window.__diffClickLogs.push(args.map(String).join(' '));
        window.__diffClickOriginalDebug(...args);
      };
      window.fetch = async (...args) => {
        const response = await window.__diffClickOriginalFetch(...args);
        const url = new URL(typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
        if (url.pathname !== ${JSON.stringify(`/session/${sessionID}/message`)} || !response.ok) return response;
        const rows = await response.clone().json();
        const user = rows.find(row => row.info.role === 'user');
        if (!user) throw Error('test user snapshot missing');
        user.info.summary = { diffs: ${JSON.stringify(
          [file, absolute].map((path) => ({
            file: path,
            before: "",
            after: marker,
            additions: 1,
            deletions: 0,
            status: "added",
            size: marker.length,
          })),
        )} };
        return new Response(JSON.stringify(rows), { status: response.status, headers: response.headers });
      };
    })()`)
    await navigate(`/${Buffer.from(directory).toString("base64url")}/session/${sessionID}`)
    const selector = '[data-slot="session-turn-diff-card"]'
    await wait("two real timeline cards", () => cdp.evaluate(`document.querySelectorAll('${selector}').length === 2`))

    for (const [index, modifier] of [
      [0, "cmd"],
      [1, "ctrl"],
    ] as const) {
      await cdp.evaluate("window.__diffClickLogs.length = 0")
      if (modifier === "cmd") {
        const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
          const card = document.querySelectorAll('${selector}')[${index}];
          card.scrollIntoView({block:'center'});
          const rect = card.getBoundingClientRect();
          return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
        })()`)
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.call("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1, modifiers: 4 })
        }
      } else {
        // macOS treats physical Ctrl+click as context-menu; simulate a Windows click event.
        await cdp.evaluate(`document.querySelectorAll('${selector}')[${index}].dispatchEvent(
          new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true}))`)
      }
      await wait(`${modifier} reveals file`, () =>
        cdp.evaluate(
          `window.__diffClickLogs.some(line=>line.includes(${JSON.stringify(`[file-link] revealed session=${sessionID} target=${absolute}`)}))`,
        ),
      )
      assert.equal(await cdp.evaluate("window.__diffClickLogs.some(line=>line.includes('[turn-review] open '))"), false)
      assert.equal(await cdp.evaluate("window.__diffClickLogs.some(line=>line.includes('mod=" + modifier + "'))"), true)
      log(`PASS ${modifier}+click reveals ${index === 0 ? "relative" : "absolute"} path without opening review`)
    }

    await cdp.evaluate(`window.__diffClickLogs.length = 0;document.querySelector('${selector}').click()`)
    assert.equal(await cdp.evaluate("window.__diffClickLogs.some(line=>line.includes('[turn-review] open '))"), true)
    assert.equal(await cdp.evaluate("window.__diffClickLogs.some(line=>line.includes('[file-link] reveal '))"), false)
    log("PASS ordinary click still opens turn review without revealing file")

    if (Bun.argv.includes("--finder")) {
      const result = Bun.spawnSync([
        "osascript",
        "-e",
        'tell application "Finder" to get POSIX path of (item 1 of (get selection) as alias)',
      ])
      assert.equal(result.exitCode, 0, result.stderr.toString())
      assert.equal(result.stdout.toString().trim(), absolute)
      log("PASS native Finder selected the actual changed file")
    }
  } finally {
    await cdp.evaluate(`(() => {
      if (window.__diffClickOriginalFetch) window.fetch = window.__diffClickOriginalFetch;
      if (window.__diffClickOriginalDebug) console.debug = window.__diffClickOriginalDebug;
      delete window.__diffClickOriginalFetch;
      delete window.__diffClickOriginalDebug;
      delete window.__diffClickLogs;
    })()`)
    await navigate(previous)
    if (sessionID) await request(`/session/${sessionID}`, "DELETE")
    await rm(directory, { recursive: true, force: true })
    log("test data cleaned; original fetch, logger and route restored")
  }
})
