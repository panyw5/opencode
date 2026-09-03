import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { LocationLifecycle } from "@/project/location-lifecycle"
import { Project } from "@/project/project"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
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

// A request routed at a directory that no longer exists on disk must not trigger a full
// instance bootstrap: bootstrap's async filesystem work can escape as unhandled rejections
// (observed as sidecar crashes for deleted worktrees). Answer with a clean 404 instead;
// a response defect passes through the error boundary untouched.
const missingDirectoryResponse = (directory: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      name: "DirectoryNotFound",
      data: { directory },
    },
    { status: 404 },
  )

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  lifecycle: LocationLifecycle.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const directory = decode(route.directory)
    return yield* lifecycle.provide(
      { directory, purpose: "http-request" },
      effect.pipe(Effect.provideService(WorkspaceRef, route.workspaceID)),
    )
  }).pipe(
    // Compatibility mapping: keep answering the existing 404 shape for
    // directories the lifecycle gate rejects (missing on disk, deleting, or
    // deleted). The typed error now originates from LocationLifecycle instead
    // of a bare existsSafe probe, and a response defect still passes through
    // the error boundary untouched.
    // catchIf with a refinement keeps the generic handler error E intact,
    // which catchTags cannot express here.
    Effect.catchIf(isAdmissionError, (error) => Effect.die(missingDirectoryResponse(error.directory))),
  )
}

const admissionTags = new Set<string>([
  "LocationLifecycle.LocationUnavailable",
  "LocationLifecycle.LocationDeleting",
  "LocationLifecycle.LocationDeleted",
])

function isAdmissionError(error: unknown): error is LocationLifecycle.AdmissionError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    admissionTags.has((error as { _tag: unknown })._tag as string)
  )
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
  fs: AppFileSystem.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const directory = decode(route.directory)
    // eslint-disable-next-line no-console
    console.log(`[instance-context] lightweight raw=${route.directory} decoded=${directory}`)
    if (!(yield* fs.existsSafe(AppFileSystem.resolve(directory)))) {
      return yield* Effect.die(missingDirectoryResponse(directory))
    }
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
    const lifecycle = yield* LocationLifecycle.Service
    const project = yield* Project.Service
    const fs = yield* AppFileSystem.Service
    return InstanceContextMiddleware.of((effect, options) => {
      if (canUseLightweightInstanceContext({ group: options.group.identifier, endpoint: options.endpoint.name })) {
        return provideLightweightInstanceContext(effect, project, fs)
      }
      return provideInstanceContext(effect, lifecycle)
    })
  }),
)

export const instanceRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const lifecycle = yield* LocationLifecycle.Service
    return (effect) => provideInstanceContext(effect, lifecycle)
  }),
)
