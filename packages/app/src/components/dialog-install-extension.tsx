import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { For, Show, createMemo, createRenderEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { ExtensionCard, ExtensionContributions } from "./extension-card"
import {
  installationDiagnostic,
  installationDiagnosticCategory,
  installationDiagnosticKey,
} from "../extensions/install-error"
import {
  installationBlocked,
  installationDownloadHost,
  installationPublicResult,
  installationRequest,
  installationSourceLabel,
  installationUnknown,
  type InstallationBlockedState,
  type InstallationInput,
  type InstallationIntent,
  type InstallationLanguage,
  type InstallationOperations,
  type InstallationResult,
  type InstallationTranslationKey,
  type PreparedInstallation,
} from "../pages/install-actions-state"

export interface ExtensionInstallationProps extends InstallationBlockedState {
  intent: InstallationIntent
  operations: InstallationOperations
  /** Desktop bridge for local-archive mode: digest lookup and archive ops. */
  localArchiveBridge?: {
    digest: (
      path: string,
    ) => Promise<
      { ok: true; value: { path: string; size: number; sha256: string } } | { ok: false; error: { message: string } }
    >
  }
  language: InstallationLanguage
  /** Stable identity for the current server/client. Any transition permanently invalidates this dialog. */
  connection: () => unknown
  onClose: () => void
  onResult?: (result: InstallationResult) => void
  /** Wire to useDialog.show's onClose callback to invalidate before its delayed disposal. */
  registerClose?: (closed: () => void) => void
}

/** Exported separately so the real Solid form can be exercised without mocking the dialog provider. */
export function ExtensionInstallationForm(props: ExtensionInstallationProps) {
  const removal = () => props.intent.kind === "uninstall"
  const releaseUpdate = () => props.intent.kind === "update" && props.intent.source?.type === "release"
  const npmUpdate = () => props.intent.kind === "update" && props.intent.source?.type === "npm"
  const localInstall = () => props.intent.kind === "install" && "localArchive" in props.intent
  const catalogInstall = () => props.intent.kind === "install" && "releaseUrl" in props.intent
  const initialSource =
    props.intent.kind === "update" && props.intent.source?.type === "archive"
      ? "archive"
      : npmUpdate()
        ? "npm"
        : localInstall()
          ? "local"
          : "release"
  const [state, setState] = createStore({
    input: {
      sourceType: initialSource,
      spec: "",
      url: catalogInstall() && "releaseUrl" in props.intent ? props.intent.releaseUrl : "",
      sha256: "",
      version: "",
      purgeData: false,
      localPath: localInstall() && "localArchive" in props.intent ? props.intent.localArchive.path : "",
    } as InstallationInput,
    localDigest: undefined as string | undefined,
    localDigestError: undefined as string | undefined,
    phase: "edit" as "edit" | "preparing" | "preview" | "committing" | "status" | "result",
    prepared: undefined as PreparedInstallation | undefined,
    result: undefined as InstallationResult | undefined,
    error: undefined as InstallationTranslationKey | undefined,
    diagnostic: undefined as string | undefined,
    diagnosticKey: undefined as InstallationTranslationKey | undefined,
    enable: false,
    stale: false,
  })
  let alive = true
  let serial = 0
  let owned: { prepared: PreparedInstallation; operations: InstallationOperations; submitted: boolean } | undefined
  const initialConnection = props.connection()
  const intentIdentity = () => JSON.stringify(props.intent)
  const initialIntent = intentIdentity()
  const t = (key: InstallationTranslationKey) => props.language.t(key)
  const sourceOptions = createMemo(() => [
    { value: "release", label: t("config.extensions.install.release") },
    { value: "npm", label: t("config.extensions.install.npm") },
    { value: "archive", label: t("config.extensions.install.archive") },
    ...(localInstall() ? [{ value: "local", label: t("config.extensions.install.local") }] : []),
    ...(npmUpdate() ? [{ value: "version", label: t("config.extensions.install.version") }] : []),
  ])
  const blocked = () => state.stale || installationBlocked(props)
  const previewLabel = () =>
    props.intent.kind === "uninstall"
      ? "config.extensions.install.previewUninstall"
      : props.intent.kind === "update"
        ? "config.extensions.install.previewUpdate"
        : "config.extensions.install.preview"
  // The host marks this extension busy during our own prepare. Busy disables interaction,
  // but must not invalidate that operation; safe mode or unsaved settings still do.
  const invalidated = () => installationBlocked({ ...props, busy: false })
  const pending = () => ["preparing", "committing", "status"].includes(state.phase)
  const removalComplete = () =>
    state.result?.state === "committed" && state.result.committed === true && state.result.synced === true
  const removalFailed = () => !pending() && !!(state.result || state.error) && !removalComplete()
  const removalRetryable = () => removalFailed() && !state.stale && state.result?.committed !== true
  const cancelOwned = () => {
    const operation = owned
    owned = undefined
    if (operation && !operation.submitted)
      void operation.operations.cancelInstallation(operation.prepared).catch(() => {})
  }
  const closed = () => {
    if (!alive) return
    alive = false
    serial++
    cancelOwned()
  }
  props.registerClose?.(closed)
  onCleanup(closed)
  createRenderEffect(() => {
    const connection = props.connection()
    const intent = intentIdentity()
    if (connection === initialConnection && intent === initialIntent) return
    serial++
    cancelOwned()
    setState({
      stale: true,
      prepared: undefined,
      result: undefined,
      phase: "edit",
      error: "config.extensions.install.connectionChanged",
    })
  })
  createRenderEffect(() => {
    if (!invalidated() || state.phase === "committing" || state.phase === "status" || state.result) return
    serial++
    cancelOwned()
    setState({ prepared: undefined, phase: "edit" })
  })
  // Local archives are hashed automatically by main. Bind the preview to those
  // exact bytes without asking the user to find or compare a checksum.
  createRenderEffect(() => {
    if (state.input.sourceType !== "local" || state.localDigest || state.localDigestError) return
    const path = state.input.localPath
    if (!path) return
    const bridge = props.localArchiveBridge
    if (!bridge) {
      setState("localDigestError", "config.extensions.install.localDigestPending")
      return
    }
    const ticket = ++serial
    console.info("[extension-install] computing local archive digest automatically")
    void bridge
      .digest(path)
      .then((response) => {
        if (!current(ticket)) return
        console.info(`[extension-install] automatic local archive digest ready=${response.ok}`)
        if (response.ok) setState({ localDigest: response.value.sha256, localDigestError: undefined })
        else setState("localDigestError", "config.extensions.install.failed")
      })
      .catch(() => {
        if (current(ticket)) setState("localDigestError", "config.extensions.install.failed")
      })
  })
  const digestReady = () => state.localDigest !== undefined && /^[a-f0-9]{64}$/i.test(state.localDigest)

  const current = (ticket: number) =>
    alive && !state.stale && serial === ticket && props.connection() === initialConnection
  const close = () => {
    closed()
    props.onClose()
  }
  const edit = <K extends keyof InstallationInput>(key: K, value: InstallationInput[K]) => {
    if (!alive || state.stale || state.phase === "committing" || state.phase === "status" || state.result) return
    serial++
    cancelOwned()
    setState({ phase: "edit", prepared: undefined, error: undefined, diagnostic: undefined, diagnosticKey: undefined })
    setState("input", key, value)
  }
  const prepare = async () => {
    if (!alive || blocked() || pending() || state.result) return
    const request = installationRequest(props.intent, {
      ...state.input,
      // Only the local transport needs an automatically computed digest. Never
      // reuse a hidden digest from a previously selected source.
      sha256: state.input.sourceType === "local" ? (state.localDigest ?? "") : "",
    })
    if (!request) {
      setState("error", "config.extensions.install.invalid")
      return
    }
    const ticket = ++serial
    const operations = props.operations
    setState({
      phase: "preparing",
      error: undefined,
      diagnostic: undefined,
      diagnosticKey: undefined,
    })
    console.info(`[extension-install] preview requested kind=${request.kind}`)
    try {
      const prepared = await operations.prepareInstallation(request)
      if (!current(ticket) || invalidated()) {
        void operations.cancelInstallation(prepared).catch(() => {})
        return
      }
      owned = { prepared, operations, submitted: false }
      setState({ phase: "preview", prepared, enable: false })
      if (removal()) await commit()
    } catch (error) {
      // Only the fixed ASCII category reaches the log; the raw error object is
      // never stringified so tokens and capabilities stay out of the console.
      console.warn(
        `[extension-install] preview failed kind=${request.kind} category=${installationDiagnosticCategory(error)}`,
      )
      if (current(ticket))
        setState({
          phase: "edit",
          error: "config.extensions.install.failed",
          diagnostic: installationDiagnostic(error),
          diagnosticKey: installationDiagnosticKey(error),
        })
    }
  }
  const finish = (result: InstallationResult, prepared: PreparedInstallation) => {
    const safe = installationPublicResult(result, prepared.token)
    setState({ result: safe, phase: "result", error: undefined })
    if (removal())
      console.info(
        `[extension-remove] outcome=${removalComplete() ? "removed" : "failed"} state=${safe.state} committed=${safe.committed} synced=${safe.synced} cleanupPending=${safe.cleanupPending} warnings=${safe.warnings.length}`,
      )
    props.onResult?.(safe)
  }
  const commit = async () => {
    const operation = owned
    console.info(
      `[extension-install] confirm clicked alive=${alive} blocked=${blocked()} phase=${state.phase} owned=${!!operation}`,
    )
    if (!alive || blocked() || state.phase !== "preview" || !operation) return
    const expiresAt = Number(operation.prepared.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      cancelOwned()
      setState({ phase: "edit", prepared: undefined, error: "config.extensions.install.expired" })
      return
    }
    const ticket = ++serial
    operation.submitted = true
    setState({ phase: "committing", error: undefined })
    console.info(`[extension-install] commit requested kind=${operation.prepared.kind} id=${operation.prepared.id}`)
    try {
      const result = await operation.operations.commitInstallation(operation.prepared, {
        enable: state.enable,
        ...(operation.prepared.registryUpgrade ? { acceptRegistryUpgrade: true } : {}),
      })
      console.info(
        `[extension-install] commit returned state=${result.state} committed=${result.committed} synced=${result.synced} current=${current(ticket)}`,
      )
      if (current(ticket)) finish(result, operation.prepared)
    } catch (error) {
      console.warn(
        `[extension-install] commit response failed code=${(error as { code?: string })?.code ?? "transport"} current=${current(ticket)}`,
      )
      // A lost response is not proof that the registry write failed. Keep the capability for status, never retry install.
      if (!current(ticket)) return
      if (!removal()) return finish(installationUnknown(operation.prepared), operation.prepared)
      setState({ result: installationUnknown(operation.prepared), phase: "result" })
      await status()
    }
  }
  const status = async (retryRemoval = false) => {
    const operation = owned
    if (!alive || blocked() || pending() || !operation) return
    const ticket = ++serial
    setState({ phase: "status", error: undefined })
    try {
      const result = await operation.operations.installationStatus(operation.prepared)
      if (!current(ticket)) return
      if (result.state === "prepared") {
        operation.submitted = false
        // Status deliberately has no token. Keep the original identity-bound object/capability.
        setState({ result: undefined, phase: "preview" })
        if (removal()) {
          if (retryRemoval) await commit()
          else setState({ result: undefined, phase: "result", error: "config.extensions.install.failed" })
        }
      } else {
        finish(result, operation.prepared)
        if (removal() && retryRemoval && result.committed === false) await restartRemoval()
      }
    } catch {
      if (current(ticket)) setState({ phase: "result", error: "config.extensions.install.statusFailed" })
    }
  }
  const restartRemoval = async () => {
    if (!alive || blocked()) return
    cancelOwned()
    setState({ phase: "edit", prepared: undefined, result: undefined, error: undefined })
    await prepare()
  }
  const retryRemoval = async () => {
    if (!alive || blocked() || !removalRetryable()) return
    if (state.result?.committed === false) return restartRemoval()
    // Resolve an uncertain commit with its original capability before another write.
    if (owned?.submitted) return status(true)
    if (owned) {
      setState({ phase: "preview", result: undefined, error: undefined })
      return commit()
    }
    await restartRemoval()
  }
  const back = () => {
    if (pending() || state.result) return
    serial++
    cancelOwned()
    setState({ phase: "edit", prepared: undefined, error: undefined })
  }
  const list = (title: InstallationTranslationKey, values: string[]) => (
    <ExtensionCard title={t(title)}>
      <Show when={values.length} fallback={<p>{t("config.extensions.install.none")}</p>}>
        <ul class="list-disc pl-5">
          <For each={values}>{(value) => <li class="break-all">{value}</li>}</For>
        </ul>
      </Show>
    </ExtensionCard>
  )
  return (
    <div
      class="flex min-h-0 max-h-[70vh] flex-1 flex-col text-13-regular text-text-base"
      data-extension-install={props.intent.kind}
    >
      <div data-install-scroll class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
        <Show when={blocked() && !pending() && !state.stale}>
          <p role="status">{t("config.extensions.install.blocked")}</p>
        </Show>
        <Show when={!removal() && state.error}>
          {(error) => (
            <p role="alert" class="text-text-danger-base">
              {t(error())}
            </p>
          )}
        </Show>
        <Show when={!removal() && state.error && state.diagnostic}>
          <p role="alert" data-install-diagnostic class="break-words text-text-danger-base">
            {state.diagnosticKey ? t(state.diagnosticKey) : state.diagnostic}
          </p>
        </Show>
        <Show
          when={
            (state.phase === "edit" || state.phase === "preparing") &&
            !state.result &&
            (!removal() || (!pending() && !state.error))
          }
        >
          <Show
            when={props.intent.kind !== "uninstall"}
            fallback={
              <>
                <p>{"id" in props.intent ? props.intent.id : ""}</p>
                <p>{t("config.extensions.install.keepData")}</p>
                <Checkbox
                  checked={state.input.purgeData}
                  disabled={blocked()}
                  onChange={(value) => edit("purgeData", value)}
                >
                  {t("config.extensions.install.purgeData")}
                </Checkbox>
              </>
            }
          >
            <ExtensionCard>
              <label class="flex flex-col gap-2 text-12-medium text-text-weak">
                {t("config.extensions.install.source")}
                <Select
                  triggerProps={{ "aria-label": t("config.extensions.install.source"), "data-field": "source-type" }}
                  options={sourceOptions()}
                  current={sourceOptions().find((o) => o.value === state.input.sourceType)}
                  value={(o) => o.value}
                  label={(o) => o.label}
                  onSelect={(o) => o && edit("sourceType", o.value as InstallationInput["sourceType"])}
                  disabled={blocked() || releaseUpdate()}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                  triggerStyle={{ width: "100%" }}
                />
              </label>
              <Show when={releaseUpdate()}>
                <p data-field="release-current">{t("config.extensions.install.releaseCurrent")}</p>
              </Show>
              <div class="flex items-end gap-2" data-field="installation-source">
                <div class="min-w-0 flex-1">
                  <Show when={state.input.sourceType === "npm"}>
                    <TextField
                      aria-label={t("config.extensions.install.spec")}
                      label={t("config.extensions.install.spec")}
                      value={state.input.spec}
                      disabled={blocked()}
                      onChange={(value) => edit("spec", value)}
                    />
                  </Show>
                  <Show when={state.input.sourceType === "version"}>
                    <TextField
                      aria-label={t("config.extensions.install.version")}
                      label={t("config.extensions.install.version")}
                      value={state.input.version}
                      disabled={blocked()}
                      onChange={(value) => edit("version", value)}
                    />
                  </Show>
                  <Show when={state.input.sourceType === "release"}>
                    <TextField
                      aria-label={t("config.extensions.install.releaseUrl")}
                      label={t("config.extensions.install.releaseUrl")}
                      value={
                        props.intent.kind === "update" && props.intent.source?.type === "release"
                          ? installationSourceLabel(props.intent.source)
                          : state.input.url
                      }
                      readOnly={releaseUpdate()}
                      disabled={blocked()}
                      onChange={(value) => {
                        if (!releaseUpdate()) edit("url", value)
                      }}
                    />
                  </Show>
                  <Show
                    when={state.input.sourceType !== "local"}
                    fallback={
                      <TextField
                        aria-label={t("config.extensions.install.localArchive")}
                        label={t("config.extensions.install.localArchive")}
                        value={state.input.localPath}
                        readOnly
                        disabled={blocked()}
                      />
                    }
                  >
                    <Show when={state.input.sourceType === "archive"}>
                      <TextField
                        aria-label={t("config.extensions.install.url")}
                        label={t("config.extensions.install.url")}
                        value={state.input.url}
                        disabled={blocked()}
                        onChange={(value) => edit("url", value)}
                      />
                    </Show>
                  </Show>
                </div>
                <Button
                  class="shrink-0"
                  style={{ height: "34px" }}
                  data-action="extension-install-prepare"
                  disabled={blocked() || pending() || (state.input.sourceType === "local" && !digestReady())}
                  onClick={() => void prepare()}
                >
                  {t(pending() ? "config.extensions.install.busy" : previewLabel())}
                </Button>
              </div>
              <Show when={state.input.sourceType === "release" && !releaseUpdate()}>
                <p data-field="release-hint" class="text-12-regular text-text-weak">
                  {t("config.extensions.install.releaseHint")}
                </p>
              </Show>
              <Show when={state.input.sourceType === "local" && !state.localDigest}>
                <p data-field="local-digest" class="text-12-regular text-text-weak">
                  {state.localDigestError
                    ? t("config.extensions.install.failed")
                    : t("config.extensions.install.localDigestPending")}
                </p>
              </Show>
              <Show when={state.input.sourceType === "archive" || state.input.sourceType === "local"}>
                <p data-field="archive-trust" class="text-12-regular text-text-weak">
                  {t("config.extensions.install.archiveTrust")}
                </p>
              </Show>
            </ExtensionCard>
          </Show>
        </Show>
        <Show when={!removal() && !state.result ? state.prepared : undefined}>
          {(prepared) => (
            <>
              <Show when={prepared().source.type === "archive"}>
                <p data-field="archive-trust" class="text-12-regular text-text-weak">
                  {t("config.extensions.install.archiveTrust")}
                </p>
              </Show>
              <ExtensionCard>
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <h2 class="break-words text-16-medium text-text-strong">{prepared().name}</h2>
                    <p class="mt-1 break-all font-mono text-12-regular text-text-weak">{prepared().id}</p>
                  </div>
                  <p
                    data-preview="versions"
                    class="rounded-md bg-surface-secondary px-2 py-1 text-12-medium text-text-strong"
                  >
                    {prepared().oldVersion ? `${prepared().oldVersion} → ` : ""}
                    {prepared().version}
                  </p>
                </div>
                <Show when={prepared().versionChange || prepared().downgrade || prepared().sameVersion}>
                  <p data-preview="version-change">
                    {t(
                      prepared().downgrade || prepared().versionChange === "downgrade"
                        ? "config.extensions.install.downgrade"
                        : prepared().sameVersion || prepared().versionChange === "same-version"
                          ? "config.extensions.install.sameVersion"
                          : "config.extensions.install.upgrade",
                    )}
                  </p>
                </Show>
              </ExtensionCard>
              <div data-preview="source">
                <ExtensionCard title={t("config.extensions.install.source")}>
                  <p class="break-all">
                    {state.input.sourceType === "local"
                      ? state.input.localPath
                      : installationSourceLabel(prepared().source)}
                  </p>
                  <Show when={prepared().source.type === "release"}>
                    <section data-preview="release-integrity" class="flex flex-col gap-1">
                      <h3 class="text-13-medium text-text-strong">{t("config.extensions.install.downloadHost")}</h3>
                      <p class="break-all">{installationDownloadHost(prepared().source)}</p>
                      <p>{t("config.extensions.install.integrityMatched")}</p>
                    </section>
                  </Show>
                  <p role="alert" data-preview="trust" class="text-text-danger-base">
                    {t("config.extensions.install.unverified")}
                  </p>
                  <Show when={prepared().hasServer}>
                    <p>{t("config.extensions.install.serverWarning")}</p>
                  </Show>
                </ExtensionCard>
              </div>
              <div class="grid grid-cols-1 items-start gap-4 sm:grid-cols-2" data-preview="capabilities">
                <div data-preview="permissions" class="grid grid-cols-1 gap-3">
                  {list("config.extensions.install.permissions", prepared().permissions)}
                  <Show when={prepared().kind === "update" && prepared().permissionsAdded.length > 0}>
                    {list("config.extensions.install.permissionsAdded", prepared().permissionsAdded)}
                  </Show>
                  <Show when={prepared().kind === "update" && prepared().permissionsRemoved.length > 0}>
                    {list("config.extensions.install.permissionsRemoved", prepared().permissionsRemoved)}
                  </Show>
                </div>
                <div data-preview="contributes">
                  <ExtensionCard title={t("config.extensions.install.contributes")}>
                    <ExtensionContributions contributes={prepared().contributes} t={t} />
                  </ExtensionCard>
                </div>
              </div>
              <Show when={prepared().kind === "install"}>
                <Checkbox
                  data-field="enable"
                  checked={state.enable}
                  disabled={blocked() || pending()}
                  onChange={(value) => setState("enable", value)}
                >
                  {t("config.extensions.install.enable")}
                </Checkbox>
              </Show>
            </>
          )}
        </Show>
        <Show when={removal() && (pending() || state.result || state.error)}>
          <div
            role={removalFailed() ? "alert" : "status"}
            aria-live="polite"
            class="flex flex-col gap-2"
            data-removal-state={pending() ? "removing" : removalComplete() ? "removed" : "failed"}
          >
            <p class={removalFailed() ? "text-text-danger-base" : "text-text-strong"}>
              {t(
                pending()
                  ? "config.extensions.install.removePending"
                  : removalComplete()
                    ? "config.extensions.install.removeSuccess"
                    : "config.extensions.install.removeFailed",
              )}
            </p>
            <Show when={removalFailed()}>
              <p>
                {t(
                  state.stale
                    ? "config.extensions.install.removeConnectionChanged"
                    : state.result?.committed === true
                      ? "config.extensions.install.removeIncomplete"
                      : state.result?.state === "unknown" || state.error === "config.extensions.install.statusFailed"
                        ? "config.extensions.install.removeUnknown"
                        : "config.extensions.install.failed",
                )}
              </p>
            </Show>
          </div>
        </Show>
        <Show when={!removal() ? state.result : undefined}>
          {(result) => (
            <div role="status" class="flex flex-col gap-2" data-result={result().state}>
              <p>
                {t(
                  result().state === "unknown" || result().committed === undefined
                    ? "config.extensions.install.unknown"
                    : result().committed
                      ? "config.extensions.install.committed"
                      : result().state === "cancelled"
                        ? "config.extensions.install.cancelled"
                        : result().state === "expired"
                          ? "config.extensions.install.expired"
                          : "config.extensions.install.failed",
                )}
              </p>
              <Show when={result().committed && !result().synced}>
                <p role="alert">{t("config.extensions.install.syncPending")}</p>
              </Show>
              <Show when={result().cleanupPending}>
                <p role="alert">{t("config.extensions.install.cleanupPending")}</p>
              </Show>
              <For each={result().warnings}>{(warning) => <p class="break-all">{warning}</p>}</For>
              <Button
                data-action="extension-install-status"
                disabled={blocked() || pending()}
                onClick={() => void status()}
              >
                {t(pending() ? "config.extensions.install.busy" : "config.extensions.install.status")}
              </Button>
            </div>
          )}
        </Show>
      </div>
      <div
        data-install-footer
        class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border-weak-base px-5 py-4"
      >
        <Show when={!removal() && state.prepared && !state.result}>
          <Button data-action="extension-install-back" disabled={pending()} onClick={back}>
            {t("config.extensions.install.back")}
          </Button>
        </Show>
        <Show when={props.intent.kind === "uninstall" && state.phase === "edit" && !state.error && !state.result}>
          <Button
            size="small"
            data-action="extension-install-prepare"
            disabled={blocked() || pending()}
            onClick={() => void prepare()}
          >
            {t("config.extensions.install.uninstall")}
          </Button>
        </Show>
        <Show when={removal() && removalRetryable()}>
          <Button data-action="extension-remove-retry" disabled={blocked()} onClick={() => void retryRemoval()}>
            {t("config.extensions.install.retry")}
          </Button>
        </Show>
        <Button data-action="extension-install-close" onClick={close}>
          {t(
            state.result || (removal() && (pending() || state.error))
              ? "config.extensions.install.close"
              : "config.extensions.install.cancel",
          )}
        </Button>
        <Show when={!removal() && state.prepared && !state.result}>
          <Button
            data-action="extension-install-confirm"
            variant="primary"
            disabled={blocked() || pending()}
            onClick={() => void commit()}
          >
            {t(pending() ? "config.extensions.install.busy" : "config.extensions.install.confirm")}
          </Button>
        </Show>
      </div>
    </div>
  )
}

export function DialogInstallExtension(props: Omit<ExtensionInstallationProps, "onClose"> & { onClose?: () => void }) {
  const dialog = props.onClose ? undefined : useDialog()
  const title = () =>
    props.language.t(
      props.intent.kind === "install"
        ? "config.extensions.install.title"
        : props.intent.kind === "update"
          ? "config.extensions.install.update"
          : "config.extensions.install.uninstall",
    )
  return (
    <Dialog title={title()} size="large">
      <ExtensionInstallationForm {...props} onClose={() => (props.onClose ?? dialog!.close)()} />
    </Dialog>
  )
}
