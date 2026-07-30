import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const ctx = yield* store.load({ directory: decode(route.directory) })
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export function canUseLightweightInstanceContext(input: { readonly group: string; readonly endpoint: string }) {
  if (input.group === "session") {
    return ["list", "get", "children", "todo", "diff", "messages", "message"].includes(input.endpoint)
  }
  if (input.group === "v2.session") {
    return input.endpoint === "sessions" || input.endpoint === "context"
  }
  return false
}

function provideLightweightInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  project: Project.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const directory = decode(route.directory)
    // eslint-disable-next-line no-console
    console.log(`[instance-context] lightweight raw=${route.directory} decoded=${directory}`)
    const result = yield* project.fromDirectory(directory)
    const ctx = {
      directory,
      worktree: result.sandbox,
      project: result.project,
    }

    // Keep lightweight read routes independent from full instance bootstrap.
    // Full bootstrap loads project config/plugins, file watchers, LSP, and other
    // services that can be slow or blocked by project-local integrations. Write
    // routes still call provideInstanceContext and initialize the full instance
    // when those services are actually needed.

    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const project = yield* Project.Service
    return InstanceContextMiddleware.of((effect, options) => {
      if (canUseLightweightInstanceContext({ group: options.group.identifier, endpoint: options.endpoint.name })) {
        return provideLightweightInstanceContext(effect, project)
      }
      return provideInstanceContext(effect, store)
    })
  }),
)

export const instanceRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return (effect) => provideInstanceContext(effect, store)
  }),
)
