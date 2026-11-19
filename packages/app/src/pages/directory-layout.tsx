import { DataProvider } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { type PathContext } from "@opencode-ai/core/util/path"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, onCleanup, type Accessor, type ParentProps, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useLayout } from "@/context/layout"
import { LocalProvider } from "@/context/local"
import { SDKProvider, useSDK } from "@/context/sdk"
import { WorkspaceFileTreeProvider } from "@/context/file/workspace-tree"
import { SkillsProvider } from "@/context/skills"
import { sessionTabsTargetHref, useSessionTabs } from "@/context/session-tabs"
import { SyncProvider, useSync } from "@/context/sync"
import { domainFromDirectory, extraAgentByDirectory } from "@/pages/layout/extra-agents"
import { openPresentationSource } from "@/pages/session/presentation-source"
import { openPresentedTask } from "@/pages/layout/open-task"
import { authTokenFromCredentials } from "@/utils/server"
import {
  directoryProviderKey,
  newSessionProjectLabel,
  sameWorkspacePath,
  shouldNavigateDirectory,
  workspacePathContext,
} from "@/pages/layout/helpers"
import { NewSessionProjectPill } from "@/components/new-session-project-pill"
import { decode64 } from "@/utils/base64"

let nextProviderID = 0

function directoryDebug(
  event: string,
  input: { rawPath?: string; logicalPath?: string; identity?: string; providerID?: number; navigated?: boolean },
) {
  if (!import.meta.env.DEV) return
  console.debug(`[directory-layout] ${event}`, input)
}

function DirectoryDataProvider(
  props: ParentProps<{
    directory: Accessor<string>
    identity: string
    setDirectory: (directory: string) => void
  }>,
) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const sync = useSync()
  const sdk = useSDK()
  const platform = usePlatform()
  const server = useServer()
  const directory = createMemo(props.directory)
  const slug = createMemo(() => base64Encode(directory()))
  const providerID = ++nextProviderID
  let previousDirectory = directory()

  directoryDebug("provider-created", {
    rawPath: previousDirectory,
    logicalPath: previousDirectory,
    identity: props.identity,
    providerID,
  })
  onCleanup(() => {
    directoryDebug("provider-disposed", {
      rawPath: previousDirectory,
      logicalPath: previousDirectory,
      identity: props.identity,
      providerID,
    })
  })

  createEffect(() => {
    const next = directory()
    if (next === previousDirectory) return
    directoryDebug("provider-reused", {
      rawPath: previousDirectory,
      logicalPath: next,
      identity: props.identity,
      providerID,
    })
    previousDirectory = next
  })

  createEffect(() => {
    const next = sync.data.path.directory
    const current = directory()
    if (!next || next === current) return

    const navigateRequired = shouldNavigateDirectory(current, next, sdk.pathContext)
    directoryDebug("route-canonicalized", {
      rawPath: current,
      logicalPath: next,
      identity: props.identity,
      providerID,
      navigated: navigateRequired,
    })
    if (!navigateRequired || sameWorkspacePath(current, next, sdk.pathContext)) {
      // Keep the route/provider identity stable while allowing the backend's
      // case-preserving logical path to flow through SDK and UI consumers.
      props.setDirectory(next)
      return
    }

    const routeSlug = params.dir ?? slug()
    const routePrefix = `/${routeSlug}`
    const path = location.pathname.startsWith(routePrefix)
      ? location.pathname.slice(routePrefix.length)
      : location.pathname
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  return (
    <DataProvider
      data={sync.data as never}
      directory={directory()}
      onNavigateToSession={(sessionID: string) => navigate(`/${slug()}/session/${sessionID}`)}
      onSessionHref={(sessionID: string) => `/${slug()}/session/${sessionID}`}
      onOpenExternalSession={async (part) => {
        console.debug(`[external-session] open parent=${part.sessionID} part=${part.id}`)
        const result = await sdk.client.session.externalSession(
          { sessionID: part.sessionID, messageID: part.messageID, partID: part.id },
          { throwOnError: true },
        )
        if (!result.data) throw new Error("External child session unavailable")
        console.debug(`[external-session] navigate child=${result.data.id}`)
        navigate(`/${slug()}/session/${result.data.id}`)
      }}
      onAbortSession={(sessionID: string) => {
        void sdk.client.session.abort({ sessionID }).catch(() => undefined)
      }}
      loadPresentation={async ({ sessionID, artifactID, variant, signal }) => {
        console.debug(`[presentation] load start session=${sessionID} artifact=${artifactID} variant=${variant}`)
        const url = new URL(
          `/session/${encodeURIComponent(sessionID)}/presentation/${encodeURIComponent(artifactID)}`,
          sdk.url,
        )
        url.searchParams.set("directory", sdk.directory)
        url.searchParams.set("variant", variant)
        const headers = new Headers()
        const auth = server.currentFor(domainFromDirectory(sdk.directory))?.http
        if (auth?.password) {
          headers.set(
            "authorization",
            `Basic ${authTokenFromCredentials({ username: auth.username, password: auth.password })}`,
          )
        }
        try {
          const response = await (platform.fetch ?? fetch)(url.toString(), { headers, signal })
          if (!response.ok) throw new Error(`Presentation unavailable (${response.status})`)
          const blob = await response.blob()
          console.debug(
            `[presentation] load success session=${sessionID} artifact=${artifactID} variant=${variant} bytes=${blob.size} mime=${blob.type}`,
          )
          return blob
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(
            `[presentation] load failed session=${sessionID} artifact=${artifactID} variant=${variant} error=${message}`,
          )
          throw error
        }
      }}
      openPresentationSource={openPresentationSource}
      onOpenTask={openPresentedTask}
      onAdvisorIntervention={(input) => {
        const callID = input.callID
        if (input.action === "start") {
          return sdk.client.session.advisorInterventionStart({ sessionID: input.sessionID, callID }).then((result) => {
            if (result.data !== true) throw new Error("Advisor intervention was not accepted")
          })
        }
        if (input.action === "finish") {
          return sdk.client.session.advisorInterventionFinish({ sessionID: input.sessionID, callID }).then((result) => {
            if (result.data !== true) throw new Error("Advisor intervention could not be finished")
          })
        }
        return sdk.client.session
          .advisorInterventionMessage({
            sessionID: input.sessionID,
            callID,
            message: input.message ?? "",
          })
          .then((result) => {
            if (result.data !== true) throw new Error("Advisor message was not accepted")
          })
      }}
    >
      <LocalProvider>{props.children}</LocalProvider>
    </DataProvider>
  )
}

function DirectoryProviders(
  props: ParentProps<{
    identity: string
    routeDirectory: Accessor<string>
    context: Accessor<PathContext>
  }>,
) {
  // This signal belongs to the keyed identity scope. A true identity change
  // constructs a fresh scope with the matching logical path, while a spelling
  // change keeps the existing provider tree and SDK state alive.
  const [directory, setDirectory] = createSignal(props.routeDirectory())

  createEffect(() => {
    const next = props.routeDirectory()
    if (!next) return
    setDirectory((current) => (!current || shouldNavigateDirectory(current, next, props.context()) ? next : current))
  })

  return (
    <SDKProvider directory={directory}>
      <WorkspaceFileTreeProvider identity={props.identity}>
        <SyncProvider>
          <SkillsProvider>
            <ProjectStatusPortal directory={directory} />
            <DirectoryDataProvider directory={directory} identity={props.identity} setDirectory={setDirectory}>
              {props.children}
            </DirectoryDataProvider>
          </SkillsProvider>
        </SyncProvider>
      </WorkspaceFileTreeProvider>
    </SDKProvider>
  )
}

function ProjectStatusPortal(props: { directory: Accessor<string> }) {
  const language = useLanguage()
  const params = useParams()
  const navigate = useNavigate()
  const layout = useLayout()
  const sessionTabs = useSessionTabs()
  const mount = createMemo(() => document.getElementById("opencode-titlebar-center-project"))
  const directory = createMemo(props.directory)
  const projectLabel = createMemo(() => {
    const dir = directory()
    return newSessionProjectLabel(dir, layout.projects.list(), {
      extraName: extraAgentByDirectory(dir)?.label,
      sidebarRoot: layout.sidebar.project(),
    })
  })
  const projects = createMemo(() => layout.projects.rail())
  const newSessionIn = (projectDirectory: string) => {
    console.debug(`[directory-layout] new-session-project current=${directory() || "none"} target=${projectDirectory}`)
    const draft = sessionTabs.createDraft(projectDirectory, "button")
    navigate(sessionTabsTargetHref({ type: "draft", ...draft }))
  }

  return (
    <Show when={mount()}>
      {(node) => (
        <Portal mount={node()}>
          <NewSessionProjectPill
            projectLabel={projectLabel()}
            projects={projects()}
            activeDirectory={directory()}
            onPrimary={() => {
              if (!params.dir) return
              console.debug(
                `[directory-layout] new-session dir=${directory() || "none"} project=${projectLabel() || "none"}`,
              )
              const draft = sessionTabs.createDraft(directory(), "button")
              navigate(sessionTabsTargetHref({ type: "draft", ...draft }))
            }}
            onSelect={newSessionIn}
          />
        </Portal>
      )}
    </Show>
  )
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const navigate = useNavigate()
  const platform = usePlatform()
  const server = useServer()
  let invalid = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decode64(params.dir) ?? ""
  })
  const context = createMemo(() =>
    workspacePathContext({ os: platform.os, isLocal: !!server.isLocal(), directory: resolved() }),
  )
  const identity = createMemo(() => directoryProviderKey(resolved(), context()))

  createEffect(() => {
    const next = resolved()
    directoryDebug("route-input", {
      rawPath: params.dir,
      logicalPath: next,
      identity: directoryProviderKey(next, context()),
    })
  })
  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  return (
    <Show when={identity()} keyed>
      {(providerIdentity) => (
        <DirectoryProviders identity={providerIdentity} routeDirectory={resolved} context={context}>
          {props.children}
        </DirectoryProviders>
      )}
    </Show>
  )
}
