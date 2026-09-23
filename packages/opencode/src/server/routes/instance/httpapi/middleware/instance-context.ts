import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { ProjectLocation } from "@/project/location"
import { LocationLifecycle } from "@/project/location-lifecycle"
import { Project } from "@/project/project"
import type { InstanceContext } from "@/project/instance-context"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import * as Log from "@opencode-ai/core/util/log"
import { WorkspaceRouteContext, type RouteSession } from "./workspace-routing"
import { readMathProblemIdentity } from "@/math/identity"

const log = Log.create({ service: "httpapi.instance-context" })

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
  project: Project.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const directory = decode(route.directory)
    if (route.session) {
      const owned = yield* sessionOwnerContext(route.session, project)
      if (owned) {
        log.info("session owner context selected", {
          sessionID: route.session.id,
          parentSessionID: route.session.parentID,
          agent: route.session.agent,
          ownerProjectID: owned.project.id,
          ownerLocationID: owned.location.id,
          executionDirectory: directory,
        })
        return yield* lifecycle.provide(
          {
            directory: owned.location.directory,
            runtimeDirectory: directory,
            purpose: "http-request",
            project: owned.project,
            worktree: owned.project.worktree,
            location: owned.location,
          },
          effect.pipe(Effect.provideService(WorkspaceRef, route.workspaceID)),
        )
      }
    }
    const problemOwner = yield* problemOwnerContext(directory, project)
    if (problemOwner) {
      log.info("MathProblem execution context selected", {
        ownerProjectID: problemOwner.project.id,
        problemID: problemOwner.problemID,
        locationID: problemOwner.location.id,
        executionDirectory: directory,
      })
      return yield* lifecycle.provide(
        {
          directory: problemOwner.location.directory,
          runtimeDirectory: directory,
          purpose: "http-request",
          project: problemOwner.project,
          worktree: problemOwner.project.worktree,
          location: problemOwner.location,
        },
        effect.pipe(Effect.provideService(WorkspaceRef, route.workspaceID)),
      )
    }
    const registration = yield* requestRegistration(directory, project)
    return yield* lifecycle.provide(
      { directory, purpose: "http-request", registration },
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

function sessionOwnerContext(session: RouteSession, project: Project.Interface) {
  return Effect.gen(function* () {
    log.info("session owner lookup started", {
      sessionID: session.id,
      parentSessionID: session.parentID,
      sessionProjectID: session.projectID,
      sessionLocationID: session.locationID,
      executionDirectory: session.directory,
    })
    const owner = yield* project.get(session.projectID)
    if (!owner) {
      log.error("session owner project missing", { sessionID: session.id, ownerProjectID: session.projectID })
      return undefined
    }
    const byID = session.locationID ? ProjectLocation.getByID(session.locationID) : undefined
    const location = byID?.projectID === owner.id ? byID : ProjectLocation.getByDirectory(owner.worktree)
    if (!location || location.projectID !== owner.id) {
      log.warn("session owner location unavailable", {
        sessionID: session.id,
        ownerProjectID: owner.id,
        locationID: session.locationID,
        ownerWorktree: owner.worktree,
      })
      return undefined
    }
    log.info("session owner lookup completed", {
      sessionID: session.id,
      ownerProjectID: owner.id,
      ownerLocationID: location.id,
      ownerDirectory: location.directory,
    })
    return { project: owner, location } satisfies Pick<InstanceContext, "project" | "location">
  })
}

function problemOwnerContext(directory: string, project: Project.Interface) {
  return Effect.gen(function* () {
    const identity = yield* Effect.sync(() => readMathProblemIdentity(AppFileSystem.resolve(directory)))
    if (!identity) return undefined
    const owner = yield* project.get(identity.ownerProjectID as Project.Info["id"])
    const location = ProjectLocation.getByDirectory(AppFileSystem.resolve(identity.ownerDirectory))
    if (!owner || !location || location.projectID !== owner.id) {
      log.error("MathProblem owner context could not be resolved", {
        ownerProjectID: identity.ownerProjectID,
        problemID: identity.problemID,
        ownerDirectory: identity.ownerDirectory,
        directory,
      })
      return yield* Effect.die(new Error(`MathProblem owner context is unavailable for ${identity.problemID}`))
    }
    return { project: owner, location, problemID: identity.problemID }
  })
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

/**
 * HTTP requests are not always user navigation. Detached Math workers call
 * their own HTTP API while their directory is registered as an internal
 * project. Re-resolving that directory with the default registration would
 * incorrectly promote it back into the sidebar.
 */
export function internalProjectRegistration(project: Pick<Project.Info, "visibility" | "kind"> | undefined) {
  if (project?.visibility !== "internal") return undefined
  return {
    visibility: "internal" as const,
    ...(project.kind ? { kind: project.kind } : {}),
  }
}

function requestRegistration(directory: string, project: Project.Interface) {
  return Effect.gen(function* () {
    const location = yield* Effect.sync(() => ProjectLocation.getByDirectory(AppFileSystem.resolve(directory)))
    const current = location ? yield* project.get(location.projectID) : undefined
    const registration = internalProjectRegistration(current)
    log.info("http project registration resolved", {
      directory,
      locationID: location?.id,
      projectID: location?.projectID,
      existingVisibility: current?.visibility,
      existingKind: current?.kind,
      preservedInternal: registration?.visibility === "internal",
    })
    return registration
  })
}

export function canUseLightweightInstanceContext(input: { readonly group: string; readonly endpoint: string }) {
  if (input.group === "project") return ["list", "current", "open"].includes(input.endpoint)
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
    const resolvedDirectory = AppFileSystem.resolve(directory)
    log.info("lightweight instance context start", { rawDirectory: route.directory, directory: resolvedDirectory })
    if (!(yield* fs.existsSafe(resolvedDirectory))) {
      return yield* Effect.die(missingDirectoryResponse(directory))
    }
    const owned = route.session ? yield* sessionOwnerContext(route.session, project) : undefined
    const problemOwner = owned ? undefined : yield* problemOwnerContext(directory, project)
    const registration = owned || problemOwner ? undefined : yield* requestRegistration(directory, project)
    const result = owned
      ? { project: owned.project, location: owned.location, sandbox: owned.project.worktree }
      : problemOwner
        ? { project: problemOwner.project, location: problemOwner.location, sandbox: problemOwner.project.worktree }
        : yield* project.fromDirectory(directory, registration)
    log.info("lightweight instance context resolved", {
      directory,
      projectID: result.project.id,
      visibility: result.project.visibility,
      kind: result.project.kind,
      preservedInternal: registration?.visibility === "internal",
    })
    const ctx = {
      directory,
      worktree: result.sandbox,
      project: result.project,
      location: result.location,
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
      return provideInstanceContext(effect, lifecycle, project)
    })
  }),
)

export const instanceRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const lifecycle = yield* LocationLifecycle.Service
    const project = yield* Project.Service
    return (effect) => provideInstanceContext(effect, lifecycle, project)
  }),
)
