import { Select } from "@opencode-ai/ui/select"
import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { domainFromDirectory } from "@/pages/layout/extra-agents"
import { workspaceKey } from "@/pages/layout/helpers"
import { createReviewDataService, type VcsMode } from "./review-data-service"
import { SessionReviewTab, type SessionReviewTabProps } from "./review-tab"

export function DraftWorkspaceReview(props: {
  worktree: string
  root: string
  git: boolean
  loading: boolean
  view: SessionReviewTabProps["view"]
  onViewFile: NonNullable<SessionReviewTabProps["onViewFile"]>
}) {
  const { t } = useLanguage()
  const directory = () => (props.worktree === "main" ? props.root : props.worktree)
  const empty = () => {
    if (props.worktree === "create") return t("session.review.worktreeNotCreated")
    if (props.loading) return t("session.review.loadingChanges")
    return t("session.review.noVcs")
  }

  return (
    <Show
      when={props.git && props.worktree !== "create" && directory()}
      keyed
      fallback={
        <SessionReviewTab
          view={props.view}
          diffs={() => []}
          diffStyle="unified"
          empty={<p class="p-4 text-text-weak">{empty()}</p>}
        />
      }
    >
      {(current) => <WorkspaceReview directory={current} view={props.view} onViewFile={props.onViewFile} />}
    </Show>
  )
}

function WorkspaceReview(props: {
  directory: string
  view: SessionReviewTabProps["view"]
  onViewFile: NonNullable<SessionReviewTabProps["onViewFile"]>
}) {
  const { t } = useLanguage()
  const sdk = useSDK()
  const layout = useLayout()
  const globalSDK = useGlobalSDK()
  const directory = props.directory
  const domain = domainFromDirectory(sdk.directory)
  const key = workspaceKey(directory, sdk.pathContext)
  const sameWorkspace = key === workspaceKey(sdk.directory, sdk.pathContext)
  const client = sameWorkspace ? sdk.client : sdk.createClient({ directory, throwOnError: true })
  const [state, setState] = createStore({ mode: "git" as VcsMode, compareBranch: false })
  const options = createMemo<VcsMode[]>(() => (state.compareBranch ? ["git", "branch"] : ["git"]))
  const review = createReviewDataService({
    directory: () => directory,
    enabled: () => true,
    visible: () => true,
    active: () => state.mode,
    fetch: (mode) => client.vcs.diff({ mode }).then((result) => result.data ?? []),
  })
  let disposed = false
  let generation = 0
  const loadBranch = async () => {
    const request = ++generation
    try {
      const { data } = await client.vcs.get()
      if (disposed || request !== generation) return
      const compareBranch = !!data?.branch && !!data.default_branch && data.branch !== data.default_branch
      setState({ compareBranch, mode: compareBranch ? state.mode : "git" })
    } catch {
      if (!disposed && request === generation) console.debug("[draft-workspace-review] branch metadata unavailable")
    }
  }
  void loadBranch()
  createEffect(() => review.ensure(state.mode, "open"))
  const stop = globalSDK.listenAll((event) => {
    if (event.domain !== domain || workspaceKey(event.name, sdk.pathContext) !== key) return
    if (event.details.type === "vcs.branch.updated") {
      void loadBranch()
      review.refresh(state.mode, "branch")
    }
    if (event.details.type === "file.watcher.updated" && !event.details.properties.file.startsWith(".git/")) {
      review.notifyEvents()
    }
  })
  onCleanup(() => {
    disposed = true
    stop()
    review.reset()
    review.dispose()
  })

  const entry = () => review.state[state.mode]
  const empty = () => {
    if (entry().error) return t("common.requestFailed")
    if (entry().initialLoading) return t("session.review.loadingChanges")
    return t(state.mode === "git" ? "session.review.noUncommittedChanges" : "session.review.noBranchChanges")
  }
  return (
    <SessionReviewTab
      title={
        <Select
          options={options()}
          current={state.mode}
          label={(mode) => t(mode === "git" ? "ui.sessionReview.title.git" : "ui.sessionReview.title.branch")}
          onSelect={(mode) => {
            if (mode) setState("mode", mode)
          }}
          variant="ghost"
          size="small"
          valueClass="text-14-medium"
        />
      }
      empty={<p class="p-4 text-text-weak">{empty()}</p>}
      directory={directory}
      diffs={() => entry().data}
      view={props.view}
      diffStyle={layout.review.diffStyle()}
      onDiffStyleChange={layout.review.setDiffStyle}
      onViewFile={sameWorkspace ? props.onViewFile : undefined}
    />
  )
}
