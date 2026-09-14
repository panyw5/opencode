import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundShell } from "../../src/background/shell"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Git } from "../../src/git"
import { LSP } from "../../src/lsp/lsp"
import { MCP } from "../../src/mcp"
import { IM } from "../../src/im/service"
import { IMOwner } from "../../src/im/owner"
import type { MessageInfo } from "../../src/im/service"
import { Database, eq } from "../../src/storage/db"
import { IMSubscription } from "../../src/im/subscription"
import { IMSubscriptionDeliveryTable } from "../../src/im/subscription.sql"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { ProjectTask } from "../../src/project-task/service"
import { LocationLifecycle } from "../../src/project/location-lifecycle"
import { Reference } from "../../src/reference/reference"
import { RepositoryCache } from "../../src/reference/repository-cache"
import { Session } from "../../src/session/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionInput } from "../../src/session/input"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { SyncEvent } from "../../src/sync"
import { SystemPrompt } from "../../src/session/system"
import { Todo } from "../../src/session/todo"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { Question } from "../../src/question"
import { Discovery } from "../../src/skill/discovery"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Ripgrep } from "../../src/file/ripgrep"
import { Image } from "../../src/image/image"
import { InstanceState } from "../../src/effect/instance-state"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { dispatch, recover, recoverWithRetry } from "../../src/im/dispatcher"
import { Target, NormalizedMessage, messageRecordID } from "../../src/im/model"
import { ProjectID } from "../../src/project/schema"
import { ProjectTable } from "../../src/project/project.sql"
import { SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import path from "node:path"

const currentRecipients = new Map<string, Target>()
function fixedTarget(channelName: string, conversationID = "chat-1", senderID = "channel-owner") {
  const target = new Target({ platform: "feishu", channelName, scope: "chat", conversationID, senderID })
  currentRecipients.set(channelName, target)
  return target
}
const owner = Layer.mock(IMOwner.Service, {
  resolve: (channelName) => {
    const target = currentRecipients.get(channelName)
    return target ? Effect.succeed(target) : Effect.fail(new IMOwner.OwnerNotReadyError({ channelName }))
  },
  list: () => Effect.succeed([]),
  observe: () => Effect.void,
})
const subscriptionLayer = IMSubscription.layer.pipe(Layer.provide(owner))

const providerConfig = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const lsp = Layer.succeed(LSP.Service, LSP.Service.of({
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  hasClients: () => Effect.succeed(false),
  touchFile: () => Effect.void,
  diagnostics: () => Effect.succeed({}),
  hover: () => Effect.succeed({}),
  definition: () => Effect.succeed([]),
  references: () => Effect.succeed([]),
  implementation: () => Effect.succeed([]),
  documentSymbol: () => Effect.succeed([]),
  workspaceSymbol: () => Effect.succeed([]),
  prepareCallHierarchy: () => Effect.succeed({}),
  incomingCalls: () => Effect.succeed([]),
  outgoingCalls: () => Effect.succeed([]),
}))

const mcp = Layer.succeed(MCP.Service, MCP.Service.of({
  status: () => Effect.succeed({}), clients: () => Effect.succeed({}), tools: () => Effect.succeed({}), prompts: () => Effect.succeed({}), resources: () => Effect.succeed({}),
  add: () => Effect.succeed({ status: { status: "disabled" as const } }), connect: () => Effect.void, disconnect: () => Effect.void,
  getPrompt: () => Effect.succeed(undefined), readResource: () => Effect.succeed(undefined), startAuth: () => Effect.die("unexpected"), authenticate: () => Effect.die("unexpected"), finishAuth: () => Effect.die("unexpected"), removeAuth: () => Effect.void, supportsOAuth: () => Effect.succeed(false), hasStoredTokens: () => Effect.succeed(false), getAuthStatus: () => Effect.succeed("not_authenticated" as const),
}))

const infrastructure = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const bus = Bus.defaultLayer
const status = SessionStatus.layer.pipe(Layer.provideMerge(bus))
const runState = SessionRunState.layer.pipe(Layer.provide(status))
const summary = Layer.succeed(SessionSummary.Service, SessionSummary.Service.of({ summarize: () => Effect.void, diff: () => Effect.succeed([]), computeDiff: () => Effect.succeed([]) }))

const dependencies = Layer.mergeAll(
  Session.defaultLayer, Snapshot.defaultLayer, LLM.defaultLayer, Env.defaultLayer, Agent.defaultLayer, Command.defaultLayer,
  Permission.defaultLayer, Plugin.defaultLayer, Config.defaultLayer, Provider.defaultLayer, lsp, mcp, AppFileSystem.defaultLayer,
  BackgroundJob.defaultLayer, BackgroundShell.defaultLayer, SessionInput.defaultLayer, IM.defaultLayer, owner,
  subscriptionLayer, status, SyncEvent.defaultLayer, EventV2Bridge.defaultLayer,
).pipe(Layer.provideMerge(infrastructure))
const question = Question.layer.pipe(Layer.provideMerge(dependencies))
const todo = Todo.layer.pipe(Layer.provideMerge(dependencies))
const registry = ToolRegistry.layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Discovery.defaultLayer), Layer.provide(FetchHttpClient.layer), Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(RepositoryCache.defaultLayer), Layer.provide(Git.defaultLayer), Layer.provide(Reference.defaultLayer), Layer.provide(Ripgrep.defaultLayer), Layer.provide(Format.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })), Layer.provide(ProjectTask.defaultLayer), Layer.provide(SystemPrompt.defaultLayer), Layer.provideMerge(todo), Layer.provideMerge(question), Layer.provideMerge(dependencies),
)
const truncate = Truncate.layer.pipe(Layer.provideMerge(dependencies))
const processor = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provide(Image.defaultLayer), Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })), Layer.provideMerge(dependencies))
const compaction = SessionCompaction.layer.pipe(Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })), Layer.provideMerge(processor), Layer.provideMerge(dependencies))
const prompt = SessionPrompt.layer.pipe(
  Layer.provideMerge(SessionRevert.defaultLayer), Layer.provide(Image.defaultLayer), Layer.provide(Reference.defaultLayer), Layer.provide(summary),
  Layer.provideMerge(runState), Layer.provideMerge(compaction), Layer.provideMerge(processor), Layer.provideMerge(registry), Layer.provideMerge(truncate),
  Layer.provide(Instruction.defaultLayer), Layer.provide(SystemPrompt.defaultLayer), Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })), Layer.provide(ProjectTask.defaultLayer), Layer.provideMerge(dependencies), Layer.provide(summary),
)
const lifecycle = LocationLifecycle.layer.pipe(Layer.provideMerge(testInstanceStoreLayer), Layer.provide(AppFileSystem.defaultLayer))
const layer = Layer.mergeAll(TestLLMServer.layer, ProjectTask.defaultLayer, prompt, lifecycle)
const it = testEffect(layer)
const fastIt = testEffect(
  Layer.mergeAll(
    IM.defaultLayer,
    subscriptionLayer,
    SessionInput.defaultLayer,
    Layer.mock(SessionPrompt.Service, { drain: () => Effect.void }),
    Layer.mock(LocationLifecycle.Service, { provide: (_input, effect) => effect }),
  ),
)
let retryProvideCalls = 0
const retryLifecycle = Layer.mock(LocationLifecycle.Service, {
  provide: (_input, effect) => {
    retryProvideCalls++
    return retryProvideCalls === 1 ? Effect.die(new Error("simulated owner bootstrap failure")) : effect
  },
})
const retryIt = testEffect(
  Layer.mergeAll(
    IM.defaultLayer,
    subscriptionLayer,
    SessionInput.defaultLayer,
    Layer.mock(SessionPrompt.Service, { drain: () => Effect.void }),
    retryLifecycle,
  ),
)

describe("IM dispatcher", () => {
  it.instance("rejects old owner and group admissions while recovering already accepted input after owner changes", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* Effect.promise(() => Bun.write(path.join(directory, "opencode.json"), JSON.stringify(providerConfig(llm.url))))
      const projectID = (yield* InstanceState.context).project.id
      const sessions = yield* Session.Service
      const subscriptions = yield* IMSubscription.Service
      const inbox = yield* SessionInput.Service
      const im = yield* IM.Service
      const session = yield* sessions.create({ title: "Owner transition recovery" })
      const target = fixedTarget("dispatcher-owner-transition", "owner-a-chat", "owner-a")
      const subscription = yield* subscriptions.create({ projectID, sessionID: session.id, sessionDirectory: directory, target })
      const accepted = yield* im.ingest({ message: new NormalizedMessage({
        id: messageRecordID("feishu", target.channelName, "accepted-a"), platform: "feishu", channelName: target.channelName,
        eventID: "accepted-a", target, senderID: target.senderID, text: "accepted before switch",
      }) })
      yield* inbox.admit({
        id: `evt_im_${accepted.message.id}_${session.id}`, sessionID: session.id,
        prompt: { text: "accepted before switch", metadata: { externalContent: true } },
        source: `im:feishu:${target.channelName}`, delivery: "deferred",
      })
      yield* subscriptions.recordDelivery(subscription.id, accepted.message.id, accepted.message.ingestSeq)
      yield* im.ingest({ message: new NormalizedMessage({
        id: messageRecordID("feishu", target.channelName, "unaccepted-a"), platform: "feishu", channelName: target.channelName,
        eventID: "unaccepted-a", target, senderID: target.senderID, text: "not accepted before switch",
      }) })
      const groupTarget = new Target({ ...target, conversationID: "old-group-chat" })
      yield* subscriptions.create({ projectID, sessionID: session.id, sessionDirectory: directory, target: groupTarget })
      const group = yield* im.ingest({ message: new NormalizedMessage({
        id: messageRecordID("feishu", target.channelName, "old-group"), platform: "feishu", channelName: target.channelName,
        eventID: "old-group", target: groupTarget, senderID: target.senderID, text: "old arbitrary group subscription",
      }) })
      fixedTarget(target.channelName, "owner-b-chat", "owner-b")
      expect(yield* dispatch(group.message)).toMatchObject({ matched: 0, admitted: 0, failed: 0 })
      yield* llm.push(reply().text("accepted recovery only").stop())
      expect(yield* recover()).toMatchObject({ dispatched: 0 })
      expect(yield* llm.calls).toBe(1)
      expect(yield* inbox.pending(session.id)).toHaveLength(0)
      const messages = yield* sessions.messages({ sessionID: session.id, limit: 20 })
      expect(messages.filter((item) => item.info.role === "assistant")).toHaveLength(1)
      expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("not accepted before switch")))).toBe(false)
      expect(yield* recover()).toMatchObject({ dispatched: 0 })
      expect(yield* llm.calls).toBe(1)
    }),
  )

  it.instance("admits a subscribed message and drains one assistant turn", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* Effect.promise(() => Bun.write(path.join(directory, "opencode.json"), JSON.stringify(providerConfig(llm.url))))
      const sessions = yield* Session.Service
      const subscriptions = yield* IMSubscription.Service
      const inbox = yield* SessionInput.Service
      const im = yield* IM.Service
      const session = yield* sessions.create({ title: "IM dispatcher" })
      const target = fixedTarget("dispatcher-test")
      const projectID = (yield* InstanceState.context).project.id
      yield* subscriptions.create({ projectID, sessionID: session.id, sessionDirectory: directory, target })
      yield* llm.push(reply().text("dispatcher assistant").stop())
      const stored = yield* im.ingest({
        message: new NormalizedMessage({
          id: messageRecordID("feishu", "dispatcher-test", "event-1"),
          platform: "feishu",
          channelName: "dispatcher-test",
          eventID: "event-1",
          target,
          senderID: target.senderID,
          text: "hello",
        }),
      })
      expect(stored.inserted).toBe(true)
      const result = yield* dispatch(stored.message)
      expect(result).toMatchObject({ matched: 1, admitted: 1, failed: 0 })
      const messages = yield* sessions.messages({ sessionID: session.id, limit: 20 })
      expect(messages.some((item) => item.parts.some((part) => part.type === "text" && part.text.includes("dispatcher assistant")))).toBe(true)
      const otherProject = ProjectID.ascending()
      const otherSession = `ses_other_${crypto.randomUUID()}` as SessionID
      const now = Date.now()
      Database.use((db) => {
        db.insert(ProjectTable).values({ id: otherProject, worktree: path.join(directory, "other"), time_created: now, time_updated: now, sandboxes: [] }).run()
        db.insert(SessionTable).values({ id: otherSession, project_id: otherProject, slug: "other", directory: path.join(directory, "other"), title: "Other", version: "test", time_created: now, time_updated: now }).run()
      })
      expect(yield* inbox.pending(otherSession)).toHaveLength(0)
    }),
  )

  it.instance("deduplicates overlapping subscriptions and replayed events", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* Effect.promise(() => Bun.write(path.join(directory, "opencode.json"), JSON.stringify(providerConfig(llm.url))))
      const instance = yield* InstanceState.context
      const sessions = yield* Session.Service
      const subscriptions = yield* IMSubscription.Service
      const session = yield* sessions.create({ title: "IM overlap" })
      const target = fixedTarget("dispatcher-overlap")
      yield* subscriptions.create({ projectID: instance.project.id, sessionID: session.id, sessionDirectory: directory, target })
      const latestSubscription = yield* subscriptions.create({ projectID: instance.project.id, sessionID: session.id, sessionDirectory: directory, target, keyword: "hello" })
      yield* llm.push(reply().text("overlap assistant").stop())
      const message: MessageInfo = {
        id: messageRecordID("feishu", target.channelName, "event-overlap"),
        platform: "feishu", channelName: target.channelName, eventID: "event-overlap", ingestSeq: latestSubscription.startSeq + 1,
        direction: "inbound", target, senderID: target.senderID, text: "hello", timeCreated: Date.now(),
      }
      expect(yield* dispatch(message)).toMatchObject({ matched: 2, admitted: 1, failed: 0 })
      expect(yield* dispatch(message)).toMatchObject({ matched: 0, admitted: 0, failed: 0 })
      const messages = yield* sessions.messages({ sessionID: session.id, limit: 20 })
      expect(messages.filter((item) => item.info.role === "assistant")).toHaveLength(1)
    }),
  )

  it.instance("does not replay pre-subscription messages and recovers an admitted input without a new event", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* Effect.promise(() => Bun.write(path.join(directory, "opencode.json"), JSON.stringify(providerConfig(llm.url))))
      const instance = yield* InstanceState.context
      const sessions = yield* Session.Service
      const subscriptions = yield* IMSubscription.Service
      const inbox = yield* SessionInput.Service
      const im = yield* IM.Service
      const target = fixedTarget("dispatcher-recovery")
      const oldSession = yield* sessions.create({ title: "IM old" })
      const oldMessage = yield* im.ingest({
        message: new NormalizedMessage({
          id: messageRecordID("feishu", target.channelName, "event-old"), platform: "feishu", channelName: target.channelName,
          eventID: "event-old", target, senderID: target.senderID, text: "old",
        }),
      })
      yield* subscriptions.create({ projectID: instance.project.id, sessionID: oldSession.id, sessionDirectory: directory, target })
      expect(yield* recover()).toMatchObject({ dispatched: 0 })
      expect(yield* inbox.pending(oldSession.id)).toHaveLength(0)

      const session = yield* sessions.create({ title: "IM recovery" })
      const recoveryTarget = fixedTarget(target.channelName, "chat-2")
      const currentSubscription = yield* subscriptions.create({
        projectID: instance.project.id, sessionID: session.id, sessionDirectory: directory,
        target: recoveryTarget,
      })
      const message = yield* im.ingest({
        message: new NormalizedMessage({
          id: messageRecordID("feishu", target.channelName, "event-admitted"), platform: "feishu", channelName: target.channelName,
          eventID: "event-admitted", target: recoveryTarget, senderID: recoveryTarget.senderID, text: "recover me",
        }),
      })
      const admissionID = `evt_im_${message.message.id}_${session.id}`
      yield* inbox.admit({
        id: admissionID,
        sessionID: session.id,
        prompt: { text: "recover me", metadata: { externalContent: true } },
        source: "im:feishu:dispatcher-recovery",
        delivery: "deferred",
      })
      yield* subscriptions.recordDelivery(currentSubscription.id, message.message.id, message.message.ingestSeq)
      yield* llm.push(reply().text("recovered assistant").stop())
      const recovered = yield* recover()
      expect(recovered.dispatched).toBe(0)
      expect(yield* inbox.pending(session.id)).toHaveLength(0)
      expect(yield* llm.calls).toBe(1)
      expect(yield* recover()).toMatchObject({ dispatched: 0 })
      expect(yield* llm.calls).toBe(1)
      expect(oldMessage.inserted).toBe(true)
    }),
  )

  it.instance("recovers a message ingested after subscription creation without a new event", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* Effect.promise(() => Bun.write(path.join(directory, "opencode.json"), JSON.stringify(providerConfig(llm.url))))
      const instance = yield* InstanceState.context
      const sessions = yield* Session.Service
      const subscriptions = yield* IMSubscription.Service
      const inbox = yield* SessionInput.Service
      const im = yield* IM.Service
      const session = yield* sessions.create({ title: "IM ingest recovery" })
      const target = fixedTarget("dispatcher-ingest-recovery")
      yield* subscriptions.create({ projectID: instance.project.id, sessionID: session.id, sessionDirectory: directory, target })
      yield* llm.push(reply().text("ingest recovery assistant").stop())
      const stored = yield* im.ingest({
        message: new NormalizedMessage({
          id: messageRecordID("feishu", target.channelName, "event-ingest-recovery"), platform: "feishu",
          channelName: target.channelName, eventID: "event-ingest-recovery", target, senderID: target.senderID, text: "recover this",
        }),
      })
      expect(stored.inserted).toBe(true)
      const recovered = yield* recover()
      expect(recovered.dispatched).toBeGreaterThanOrEqual(1)
      expect(yield* inbox.pending(session.id)).toHaveLength(0)
      expect(yield* llm.calls).toBe(1)
      expect((yield* recover()).dispatched).toBe(0)
      expect(yield* llm.calls).toBe(1)
    }),
  )

  it.instance("defers a busy session without interrupting its current turn", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* Effect.promise(() => Bun.write(path.join(directory, "opencode.json"), JSON.stringify(providerConfig(llm.url))))
      const instance = yield* InstanceState.context
      const sessions = yield* Session.Service
      const subscriptions = yield* IMSubscription.Service
      const session = yield* sessions.create({ title: "IM busy" })
      const target = fixedTarget("dispatcher-busy")
      const subscription = yield* subscriptions.create({ projectID: instance.project.id, sessionID: session.id, sessionDirectory: directory, target })
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      yield* llm.hold("first", gate)
      const first: MessageInfo = {
        id: messageRecordID("feishu", target.channelName, "event-busy-1"), platform: "feishu", channelName: target.channelName,
        eventID: "event-busy-1", ingestSeq: subscription.startSeq + 1, direction: "inbound", target, senderID: target.senderID, text: "first", timeCreated: Date.now(),
      }
      const second: MessageInfo = { ...first, id: messageRecordID("feishu", target.channelName, "event-busy-2"), eventID: "event-busy-2", ingestSeq: first.ingestSeq + 1, text: "second" }
      const fiber = yield* dispatch(first).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const secondResult = yield* dispatch(second)
      expect(secondResult).toMatchObject({ matched: 1, admitted: 1, failed: 0 })
      yield* llm.push(reply().text("second").stop())
      release()
      yield* Fiber.join(fiber)
      expect(yield* llm.calls).toBe(2)
      const messages = yield* sessions.messages({ sessionID: session.id, limit: 30 })
      expect(messages.filter((item) => item.info.role === "assistant")).toHaveLength(2)
    }),
  )

  it.instance("delivers owner events out of order and rejects foreign, stopped, or paused events", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* Effect.promise(() => Bun.write(path.join(directory, "opencode.json"), JSON.stringify(providerConfig(llm.url))))
      const instance = yield* InstanceState.context
      const sessions = yield* Session.Service
      const subscriptions = yield* IMSubscription.Service
      const session = yield* sessions.create({ title: "IM ordering" })
      const target = fixedTarget("dispatcher-order")
      const subscription = yield* subscriptions.create({ projectID: instance.project.id, sessionID: session.id, sessionDirectory: directory, target })
      yield* llm.push(reply().text("two").stop(), reply().text("one").stop())
      const makeMessage = (seq: number, eventID: string, text: string): MessageInfo => ({
        id: messageRecordID("feishu", target.channelName, eventID), platform: "feishu", channelName: target.channelName,
        eventID, ingestSeq: subscription.startSeq + seq, direction: "inbound", target, senderID: "channel-owner", text, timeCreated: Date.now(),
      })
      expect(yield* dispatch({ ...makeMessage(5, "foreign-event", "foreign"), senderID: "foreign-user" })).toMatchObject({ matched: 0, admitted: 0 })
      expect(yield* dispatch(makeMessage(2, "event-2", "two"))).toMatchObject({ matched: 1, admitted: 1 })
      expect(yield* dispatch(makeMessage(1, "event-1", "one"))).toMatchObject({ matched: 1, admitted: 1 })
      expect(yield* subscriptions.stop(subscription.id, instance.project.id)).toBeDefined()
      expect(yield* dispatch(makeMessage(3, "event-3", "stopped"))).toMatchObject({ matched: 0, admitted: 0 })
      yield* subscriptions.resume(subscription.id, instance.project.id)
      expect(yield* subscriptions.pause(subscription.id, instance.project.id)).toBeDefined()
      expect(yield* dispatch(makeMessage(4, "event-4", "paused"))).toMatchObject({ matched: 0, admitted: 0 })
    }),
  )

  fastIt.instance("recovers all messages beyond the bounded recovery batch", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const instance = yield* InstanceState.context
      const subscriptions = yield* IMSubscription.Service
      const inbox = yield* SessionInput.Service
      const im = yield* IM.Service
      const sessionID = `ses_recovery_batch_${crypto.randomUUID()}` as SessionID
      const now = Date.now()
      Database.use((db) =>
        db.insert(SessionTable).values({
          id: sessionID,
          project_id: instance.project.id,
          slug: "recovery-batch",
          directory,
          title: "Recovery batch",
          version: "test",
          time_created: now,
          time_updated: now,
        }).run(),
      )
      const target = fixedTarget("dispatcher-recovery-batch")
      yield* subscriptions.create({ projectID: instance.project.id, sessionID, sessionDirectory: directory, target })
      for (let index = 0; index < 101; index++) {
        yield* im.ingest({
          message: new NormalizedMessage({
            id: messageRecordID("feishu", target.channelName, `event-${index}`), platform: "feishu",
            channelName: target.channelName, eventID: `event-${index}`, target, senderID: target.senderID, text: `message-${index}`,
          }),
        })
      }
      expect((yield* recover()).dispatched).toBe(101)
      expect(yield* inbox.pending(sessionID)).toHaveLength(101)
      expect((yield* recover()).dispatched).toBe(0)
      expect(yield* inbox.pending(sessionID)).toHaveLength(101)
      expect(yield* recover()).toMatchObject({ dispatched: 0 })
    }),
  )

  fastIt.instance("does not drop the 101st matching session", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const instance = yield* InstanceState.context
      const subscriptions = yield* IMSubscription.Service
      const inbox = yield* SessionInput.Service
      const target = fixedTarget("dispatcher-session-batch")
      const now = Date.now()
      const sessionIDs: SessionID[] = []
      let latestStartSeq = -1
      for (let index = 0; index < 101; index++) {
        const sessionID = `ses_dispatch_batch_${index}_${crypto.randomUUID()}` as SessionID
        sessionIDs.push(sessionID)
        Database.use((db) =>
          db.insert(SessionTable).values({
            id: sessionID,
            project_id: instance.project.id,
            slug: `dispatch-${index}`,
            directory,
            title: `Dispatch ${index}`,
            version: "test",
            time_created: now,
            time_updated: now,
          }).run(),
        )
        const subscription = yield* subscriptions.create({ projectID: instance.project.id, sessionID, sessionDirectory: directory, target })
        latestStartSeq = Math.max(latestStartSeq, subscription.startSeq)
      }
      const message: MessageInfo = {
        id: messageRecordID("feishu", target.channelName, "event-session-batch"), platform: "feishu",
        channelName: target.channelName, eventID: "event-session-batch", ingestSeq: latestStartSeq + 1,
        direction: "inbound", target, senderID: target.senderID, text: "fanout", timeCreated: now,
      }
      const result = yield* dispatch(message)
      expect(result).toMatchObject({ matched: 101, admitted: 101, failed: 0 })
      expect((yield* Effect.forEach(sessionIDs, (sessionID) => inbox.pending(sessionID)) ).flat()).toHaveLength(101)
    }),
  )

  retryIt.instance("retries after an owner bootstrap failure and retains one admitted input", () =>
    Effect.gen(function* () {
      retryProvideCalls = 0
      const { directory } = yield* TestInstance
      const instance = yield* InstanceState.context
      const subscriptions = yield* IMSubscription.Service
      const inbox = yield* SessionInput.Service
      const im = yield* IM.Service
      const sessionID = `ses_retry_${crypto.randomUUID()}` as SessionID
      const now = Date.now()
      Database.use((db) =>
        db.insert(SessionTable).values({
          id: sessionID, project_id: instance.project.id, slug: "retry", directory,
          title: "Retry", version: "test", time_created: now, time_updated: now,
        }).run(),
      )
      const target = fixedTarget("dispatcher-retry")
      yield* subscriptions.create({ projectID: instance.project.id, sessionID, sessionDirectory: directory, target })
      yield* im.ingest({
        message: new NormalizedMessage({
          id: messageRecordID("feishu", target.channelName, "event-retry"), platform: "feishu",
          channelName: target.channelName, eventID: "event-retry", target, senderID: target.senderID, text: "retry me",
        }),
      })
      const result = yield* recoverWithRetry(2)
      expect(result.failed).toBe(0)
      expect(retryProvideCalls).toBeGreaterThan(1)
      expect(yield* inbox.pending(sessionID)).toHaveLength(1)
    }),
  )

  it.instance("recovers an admitted input after its subscription is stopped", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* Effect.promise(() => Bun.write(path.join(directory, "opencode.json"), JSON.stringify(providerConfig(llm.url))))
      const instance = yield* InstanceState.context
      const sessions = yield* Session.Service
      const subscriptions = yield* IMSubscription.Service
      const inbox = yield* SessionInput.Service
      const session = yield* sessions.create({ title: "Stopped recovery" })
      const target = fixedTarget("dispatcher-stopped-recovery")
      const subscription = yield* subscriptions.create({ projectID: instance.project.id, sessionID: session.id, sessionDirectory: directory, target })
      yield* inbox.admit({
        id: `evt_im_stopped_${crypto.randomUUID()}` as never,
        sessionID: session.id,
        prompt: { text: "already accepted", metadata: { externalContent: true } },
        source: "im:feishu:dispatcher-stopped-recovery",
        delivery: "deferred",
      })
      yield* subscriptions.stop(subscription.id, instance.project.id)
      yield* llm.push(reply().text("stopped recovery assistant").stop())
      yield* recover()
      expect(yield* inbox.pending(session.id)).toHaveLength(0)
      expect(yield* llm.calls).toBe(1)
      const messages = yield* sessions.messages({ sessionID: session.id, limit: 20 })
      expect(messages.filter((item) => item.info.role === "assistant")).toHaveLength(1)
    }),
  )

  it.instance("recovers a promoted but unclaimed input after all subscriptions are stopped", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* Effect.promise(() => Bun.write(path.join(directory, "opencode.json"), JSON.stringify(providerConfig(llm.url))))
      const instance = yield* InstanceState.context
      const sessions = yield* Session.Service
      const subscriptions = yield* IMSubscription.Service
      const inbox = yield* SessionInput.Service
      const session = yield* sessions.create({ title: "Promoted recovery" })
      const target = fixedTarget("dispatcher-promoted-recovery")
      const subscription = yield* subscriptions.create({ projectID: instance.project.id, sessionID: session.id, sessionDirectory: directory, target })
      const inputID = `evt_im_promoted_${crypto.randomUUID()}` as never
      yield* inbox.admit({
        id: inputID,
        sessionID: session.id,
        prompt: { text: "promoted recovery", metadata: { externalContent: true } },
        source: "im:feishu:dispatcher-promoted-recovery",
        delivery: "deferred",
      })
      expect(yield* inbox.promote(session.id)).toHaveLength(1)
      expect(yield* inbox.promotedUnacked(session.id)).toHaveLength(1)
      yield* subscriptions.stop(subscription.id, instance.project.id)
      yield* llm.push(reply().text("promoted recovery assistant").stop())
      yield* recover()
      expect(yield* inbox.pending(session.id)).toHaveLength(0)
      expect(yield* inbox.promotedUnacked(session.id)).toHaveLength(0)
      expect(yield* llm.calls).toBe(1)
      yield* recover()
      expect(yield* llm.calls).toBe(1)
    }),
  )

  it.instance("seals an admitted IM message before draining so recovery cannot re-admit it", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* Effect.promise(() => Bun.write(path.join(directory, "opencode.json"), JSON.stringify(providerConfig(llm.url))))
      const instance = yield* InstanceState.context
      const sessions = yield* Session.Service
      const subscriptions = yield* IMSubscription.Service
      const inbox = yield* SessionInput.Service
      const im = yield* IM.Service
      const session = yield* sessions.create({ title: "Canonical recovery" })
      const target = fixedTarget("dispatcher-canonical-recovery")
      const subscription = yield* subscriptions.create({ projectID: instance.project.id, sessionID: session.id, sessionDirectory: directory, target })
      const message = yield* im.ingest({
        message: new NormalizedMessage({
          id: messageRecordID("feishu", target.channelName, "event-canonical"), platform: "feishu",
          channelName: target.channelName, eventID: "event-canonical", target, senderID: target.senderID, text: "canonical recovery",
        }),
      })
      const admissionID = `evt_im_${message.message.id}_${session.id}` as never
      yield* inbox.admit({
        id: admissionID,
        sessionID: session.id,
        prompt: {
          text: "<im_message source=\"feishu\" channel=\"dispatcher-canonical-recovery\" subscription=\"test\">\ncanonical recovery\n</im_message>",
          metadata: {
            imSource: "feishu",
            imChannel: target.channelName,
            imMessageID: message.message.id,
            imEventID: message.message.eventID,
            imSubscriptionID: subscription.id,
            externalContent: true,
          },
        },
        source: "im:feishu:dispatcher-canonical-recovery",
        delivery: "deferred",
      })
      yield* llm.push(reply().text("canonical assistant").stop(), reply().text("duplicate assistant").stop())
      yield* recover()
      expect(yield* llm.calls).toBe(1)
      expect(yield* inbox.pending(session.id)).toHaveLength(0)
      expect(yield* inbox.promotedUnacked(session.id)).toHaveLength(0)
      expect(Database.use((db) => db.select().from(IMSubscriptionDeliveryTable).where(eq(IMSubscriptionDeliveryTable.message_id, message.message.id)).all())).toHaveLength(1)
      yield* recover()
      expect(yield* llm.calls).toBe(1)
    }),
  )
})
