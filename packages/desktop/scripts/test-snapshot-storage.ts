import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { withCdp } from "./cdp"
import { testProviderConfig } from "../../opencode/test/lib/test-provider"

// Start an isolated development Electron app (OPENCODE_TEST_ONBOARDING=1)
// before running this script. The installed app is never used.
const log = (message: string) => console.log(`[snapshot-storage] ${message}`)
const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-snapshot-storage-"))
const marker = "SNAPSHOT_STORAGE_SIDECAR_OK"
let modelCalls = 0
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { stream?: boolean }
    modelCalls++
    log(`local model received request=${modelCalls} stream=${body.stream === true}`)
    if (!body.stream) {
      return Response.json({ choices: [{ message: { role: "assistant", content: marker } }] })
    }
    const chunk = (delta: object, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: "snapshot-storage", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    return new Response(chunk({ role: "assistant", content: marker }) + chunk({}, "stop") + "data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    })
  },
})

const scenarios = [
  { name: "non-git", git: false, disabled: false },
  { name: "disabled-git", git: true, disabled: true },
  { name: "legacy-dir-git", git: true, disabled: false },
]

try {
  await withCdp(async (cdp, target) => {
    assert(target.url.includes("localhost:5173"), "Only use the development Electron renderer on CDP 9222")
    const storage = await cdp.evaluate<string>(`(async () => {
      const server = await window.api.awaitInitialization(() => {});
      const response = await fetch(new URL('/path', server.url), { headers: { Authorization: 'Basic ' + btoa(server.username + ':' + server.password) } });
      if (!response.ok) throw new Error('Cannot read backend storage paths');
      return (await response.json()).state;
    })()`)
    assert.match(storage, /opencode-onboarding-/, "Run only against an isolated onboarding test backend")
    log(`isolated backend verified state=${storage}`)
    const navigationModule = `/@fs/${path.resolve(import.meta.dirname, "../../app/src/utils/notification-click.ts").replaceAll("\\", "/")}`
    await cdp.evaluate(`void (window.__snapshotStorageNavigation = import(${JSON.stringify(navigationModule)}).then(module => {
      window.__snapshotStorageNavigate = module.handleNotificationClick;
    }))`)
    const navigationDeadline = Date.now() + 30000
    while (
      !(await cdp.evaluate<boolean>(
        `typeof window.__snapshotStorageNavigate === 'function' && !!document.querySelector('[data-component^="sidebar-nav-"]')`,
      ))
    ) {
      assert(Date.now() < navigationDeadline, "Desktop navigation and layout did not load")
      await Bun.sleep(100)
    }

    for (const scenario of scenarios) {
      const directory = path.join(root, scenario.name)
      await fs.mkdir(directory)
      const logical = directory.replaceAll("\\", "/")
      const projectID = `dir:${createHash("sha1").update(logical).digest("hex")}`
      if (scenario.git) {
        for (const args of [
          ["init"],
          [
            "-c",
            "user.name=Snapshot QA",
            "-c",
            "user.email=snapshot@example.invalid",
            "commit",
            "--allow-empty",
            "--no-gpg-sign",
            "-m",
            "snapshot fixture",
          ],
        ]) {
          const result = Bun.spawnSync(["git", "-C", directory, ...args])
          assert.equal(result.exitCode, 0, result.stderr.toString())
        }
        await fs.writeFile(path.join(directory, ".git", "opencode"), projectID)
      }
      await fs.writeFile(path.join(directory, "notes.txt"), "snapshot verification\n")
      await fs.writeFile(
        path.join(directory, "opencode.json"),
        JSON.stringify({
          ...testProviderConfig(`${model.url}v1`),
          model: "test/test-model",
          small_model: "test/test-model",
          ...(scenario.disabled ? { snapshot: false } : {}),
        }),
      )
      log(`sending message scenario=${scenario.name} projectID=${projectID} directory=${logical}`)
      const result = await cdp.evaluate<{
        id: string
        projectID: string
        snapshots: number
        worktree?: string
      }>(`(async () => {
        const server = await window.api.awaitInitialization(() => {});
        const directory = ${JSON.stringify(logical)};
        const request = async (route, init = {}) => {
          const url = new URL(route, server.url);
          url.searchParams.set('directory', directory);
          const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(server.username + ':' + server.password) } });
          if (!response.ok) throw new Error(route + ' status=' + response.status + ' ' + await response.text());
          return response.status === 204 ? undefined : response.json();
        };
        const session = await request('/session', { method: 'POST', body: JSON.stringify({ title: ${JSON.stringify(`Snapshot storage QA: ${scenario.name}`)} }) });
        await request('/session/' + session.id + '/prompt_async', { method: 'POST', body: JSON.stringify({ model: { providerID: 'test', modelID: 'test-model' }, parts: [{ type: 'text', text: 'Reply ${marker}.' }] }) });
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const messages = await request('/session/' + session.id + '/message');
          const assistant = messages.find(message => message.info?.role === 'assistant' && message.parts?.some(part => part.type === 'text' && part.text === ${JSON.stringify(marker)}));
          if (assistant?.info?.time?.completed) {
            if (assistant.info.error) throw new Error(JSON.stringify(assistant.info.error));
            const worktree = ${scenario.git && !scenario.disabled} ? await request('/experimental/worktree', { method: 'POST', body: JSON.stringify({ name: 'storage-qa' }) }) : undefined;
            return { id: session.id, projectID: session.projectID, worktree: worktree?.directory, snapshots: messages.flatMap(message => message.parts || []).filter(part => part.type === 'step-start' && part.snapshot).length };
          }
          const failed = messages.find(message => message.info?.error);
          if (failed) throw new Error(JSON.stringify(failed.info.error));
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('No completed sidecar reply');
      })()`)
      assert.equal(result.projectID, projectID)
      assert.equal(result.snapshots > 0, scenario.git && !scenario.disabled)
      const snapshotRoot = path.join(path.dirname(path.dirname(storage)), "data", "opencode", "snapshot")
      const projectSnapshot = path.join(snapshotRoot, encodeURIComponent(projectID))
      if (scenario.git && !scenario.disabled) {
        const worktrees = await fs.readdir(projectSnapshot)
        assert.equal(worktrees.length, 1)
        assert(await fs.stat(path.join(projectSnapshot, worktrees[0], "HEAD")))
        log(`verified encoded snapshot storage scenario=${scenario.name} path=${projectSnapshot}`)
        assert(result.worktree)
        assert.equal(
          path.dirname(result.worktree),
          path.join(path.dirname(snapshotRoot), "worktree", encodeURIComponent(projectID)),
        )
        assert((await fs.stat(path.join(result.worktree, ".git"))).isFile())
        const worktreeCheck = Bun.spawnSync(["git", "-C", result.worktree, "rev-parse", "--is-inside-work-tree"])
        assert.equal(worktreeCheck.exitCode, 0, worktreeCheck.stderr.toString())
        assert.equal(worktreeCheck.stdout.toString().trim(), "true")
        log(`verified encoded worktree storage path=${result.worktree}`)
      } else {
        assert.equal(
          await fs.access(projectSnapshot).then(
            () => true,
            () => false,
          ),
          false,
        )
        log(`verified no snapshot storage scenario=${scenario.name}`)
      }
      log(`received completed reply scenario=${scenario.name} session=${result.id} snapshots=${result.snapshots}`)
      const route = `/${Buffer.from(logical).toString("base64url")}/session/${result.id}`
      // Desktop uses MemoryRouter. Navigate through the real notification path;
      // changing location.href only reloads the last persisted in-app route.
      await cdp.evaluate(`window.__snapshotStorageNavigate(${JSON.stringify(route)}); true`)
      const deadline = Date.now() + 30000
      let rendered = false
      while (Date.now() < deadline) {
        try {
          rendered = await cdp.evaluate<boolean>(`(() => {
            const page = document.querySelector('[data-component="session-page"]');
            return page?.dataset.sessionId === ${JSON.stringify(result.id)} && [...page.querySelectorAll('p')].some(node => node.textContent.trim() === ${JSON.stringify(marker)});
          })()`)
        } catch {}
        if (rendered) break
        await Bun.sleep(100)
      }
      assert(rendered, `Completed reply must appear in Electron: ${scenario.name}`)
      log(`renderer displayed reply scenario=${scenario.name}`)
    }
  })
  assert(modelCalls >= scenarios.length)
  log(`PASS scenarios=${scenarios.length} localModelCalls=${modelCalls} fixtures=${root}`)
} finally {
  model.stop(true)
}
