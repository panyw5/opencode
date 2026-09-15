import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { IM, type ListInput, type SendInput } from "../../src/im/service"
import { IMOwner } from "../../src/im/owner"
import { Target } from "../../src/im/model"
import { IMSubscription } from "../../src/im/subscription"
import { Session } from "../../src/session/session"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceState } from "../../src/effect/instance-state"
import { ImApi } from "../../src/server/routes/instance/httpapi/groups/im"
import { imHandlers } from "../../src/server/routes/instance/httpapi/handlers/im"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { it } from "../lib/effect"
import { Config } from "../../src/config/config"

const TestApi = HttpApi.make("opencode-instance").addHttpApi(ImApi)
const target = new Target({
  platform: "feishu",
  channelName: "cc",
  scope: "chat",
  conversationID: "oc_auto_discovered",
  senderID: "ou_owner",
})

describe("IM channel HTTP handlers", () => {
  it.instance("resolves recipient server-side, generates optional send IDs, and scopes reads", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const sends: SendInput[] = []
      const reads: ListInput[] = []
      const watches: IMSubscription.Info[] = []
      let currentTarget = target
      const layer = HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(imHandlers),
        Layer.provide([
          schemaErrorLayer,
          Layer.mock(Config.Service, {
            getGlobal: () =>
              Effect.succeed({
                channels: { cc: { type: "feishu", appId: "test", appSecret: "unused" }, wx: { type: "wechat" } },
              }),
          }),
          Layer.mock(IMOwner.Service, {
            resolve: (channelName) =>
              channelName === "cc"
                ? Effect.succeed(currentTarget)
                : Effect.fail(new IMOwner.ChannelNotFoundError({ channelName })),
            list: () =>
              Effect.succeed([
                {
                  channelName: "cc",
                  platform: "feishu",
                  enabled: true,
                  running: true,
                  recipientStatus: "ready",
                  recipient: { name: "Owner" },
                },
              ]),
          }),
          Layer.mock(IM.Service, {
            sendText: (input) =>
              Effect.sync(() => {
                sends.push(input)
                return {
                  ...input,
                  status: "sent" as const,
                  attemptCount: 1,
                  providerMessageID: "om_http_test",
                  timeCreated: 1,
                  timeUpdated: 1,
                }
              }),
            list: (input) =>
              Effect.sync(() => {
                reads.push(input)
                return { items: [] }
              }),
          }),
          Layer.mock(IMSubscription.Service, {
            create: (input) =>
              Effect.sync(() => {
                const row: IMSubscription.Info = {
                  ...input,
                  id: "watch-http",
                  status: "active",
                  startSeq: 0,
                  deliveryCursor: 0,
                  timeCreated: 1,
                  timeUpdated: 1,
                }
                watches.push(row)
                return row
              }),
            list: () => Effect.sync(() => watches),
            pause: () => Effect.sync(() => ({ ...watches[0]!, status: "paused" as const })),
            resume: () => Effect.sync(() => ({ ...watches[0]!, status: "active" as const })),
            stop: () => Effect.sync(() => ({ ...watches[0]!, status: "stopped" as const })),
          }),
          Layer.mock(Session.Service, {}),
          Layer.succeed(
            Authorization,
            Authorization.of((effect) => effect),
          ),
          Layer.succeed(
            InstanceContextMiddleware,
            InstanceContextMiddleware.of((effect) => effect.pipe(Effect.provideService(InstanceRef, instance))),
          ),
          Layer.succeed(
            WorkspaceRoutingMiddleware,
            WorkspaceRoutingMiddleware.of((effect) =>
              effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: instance.directory })),
            ),
          ),
        ]),
      )
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
        (server) => Effect.promise(() => server.dispose()),
      )
      const request = (path: string, payload?: object) =>
        Effect.promise(() =>
          server.handler(
            new Request(
              `http://localhost${path}`,
              payload
                ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }
                : undefined,
            ),
          ),
        )
      const channels = yield* request("/im/channels")
      const wxStatus = yield* request("/im/wechat/status?channelName=wx")
      expect(wxStatus.status).toBe(200)
      expect(yield* Effect.promise(() => wxStatus.json())).toEqual({ channelName: "wx", status: "awaiting_login" })
      const wrongPlatform = yield* request("/im/wechat/login/start", { channelName: "cc" })
      expect(wrongPlatform.status).toBe(400)
      const invalidName = yield* request("/im/wechat/login/start", { channelName: "../unsafe" })
      expect(invalidName.status).toBe(400)
      expect(channels.status).toBe(200)
      expect(yield* Effect.promise(() => channels.json())).toEqual([
        {
          channelName: "cc",
          platform: "feishu",
          enabled: true,
          running: true,
          recipientStatus: "ready",
          recipient: { name: "Owner" },
        },
      ])
      const first = yield* request("/im/send", { channelName: "cc", text: "hello" })
      const second = yield* request("/im/send", { channelName: "cc", text: "hello" })
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(sends).toHaveLength(2)
      expect(sends[0]?.id).not.toBe(sends[1]?.id)
      expect(sends[0]).toMatchObject({
        projectID: instance.project.id,
        platform: "feishu",
        target: { conversationID: target.conversationID, senderID: target.senderID },
        mode: "proactive",
      })
      const explicit = yield* request("/im/send", {
        channelName: "cc",
        text: "**hello**",
        id: "stable-notice",
        format: "markdown",
      })
      expect(explicit.status).toBe(200)
      expect(sends.at(-1)?.format).toBe("markdown")
      expect(sends[2]?.id).toBe("stable-notice")
      const read = yield* request("/im/messages?channelName=cc")
      expect(read.status).toBe(200)
      expect(reads[0]).toMatchObject({
        channelName: "cc",
        conversationID: target.conversationID,
        senderID: target.senderID,
        projectID: instance.project.id,
      })
      const missing = yield* request("/im/send", { channelName: "missing", text: "hello" })
      expect(missing.status).toBe(400)
      expect(JSON.stringify(yield* Effect.promise(() => missing.json()))).toContain("not configured")
      expect(sends).toHaveLength(3)
      const watch = yield* request("/im/subscriptions", {
        sessionID: "ses_http_owner",
        channelName: "cc",
        keyword: "deploy",
      })
      expect(watch.status).toBe(200)
      expect(watches[0]).toMatchObject({
        projectID: instance.project.id,
        sessionDirectory: instance.directory,
        target: { conversationID: target.conversationID, senderID: target.senderID },
        keyword: "deploy",
      })
      watches.push({
        ...watches[0]!,
        id: "watch-other-directory",
        sessionDirectory: `${instance.directory}/other-project`,
      })
      const listed = yield* request("/im/subscriptions")
      expect(listed.status).toBe(200)
      expect(yield* Effect.promise(() => listed.json())).toHaveLength(1)
      const otherPaused = yield* request("/im/subscriptions/watch-other-directory/pause", {})
      const otherStopped = yield* request("/im/subscriptions/watch-other-directory/stop", {})
      const otherResumed = yield* request("/im/subscriptions/watch-other-directory/resume", {})
      expect(otherPaused.status).toBe(404)
      expect(otherStopped.status).toBe(404)
      expect(otherResumed.status).toBe(404)
      const resume = yield* request("/im/subscriptions/watch-http/resume", {})
      expect(resume.status).toBe(200)
      currentTarget = new Target({ ...target, senderID: "different-owner" })
      const changed = yield* request("/im/subscriptions/watch-http/resume", {})
      expect(changed.status).toBe(400)
      expect(JSON.stringify(yield* Effect.promise(() => changed.json()))).toContain("recipient changed")
      const stop = yield* request("/im/subscriptions/watch-http/stop", {})
      expect(stop.status).toBe(200)
    }),
  )
})
