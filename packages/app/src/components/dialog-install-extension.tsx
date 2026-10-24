import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { For, Show, createRenderEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { digestMatches } from "../extensions/install-local"
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
    enable: false,
    acceptRegistryUpgrade: false,
    stale: false,
  })
  let alive = true
  let serial = 0
  let owned: { prepared: PreparedInstallation; operations: InstallationOperations; submitted: boolean } | undefined
  const initialConnection = props.connection()
  const intentIdentity = () => JSON.stringify(props.intent)
  const initialIntent = intentIdentity()
  const t = (key: InstallationTranslationKey) => props.language.t(key)
  const blocked = () => state.stale || installationBlocked(props)
  // The host marks this extension busy during our own prepare. Busy disables interaction,
  // but must not invalidate that operation; safe mode or unsaved settings still do.
  const invalidated = () => installationBlocked({ ...props, busy: false })
  const pending = () => ["preparing", "committing", "status"].includes(state.phase)
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
  // Local-archive mode: fetch the actual digest once so the user compares it
  // against the published checksum instead of typing blind.
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
    void bridge
      .digest(path)
      .then((response) => {
        if (!current(ticket)) return
        if (response.ok) setState({ localDigest: response.value.sha256, localDigestError: undefined })
        else setState("localDigestError", "config.extensions.install.failed")
      })
      .catch(() => {
        if (current(ticket)) setState("localDigestError", "config.extensions.install.failed")
      })
  })
  const digestConfirmed = () => state.localDigest !== undefined && digestMatches(state.input.sha256, state.localDigest)

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
    setState({ phase: "edit", prepared: undefined, error: undefined })
    setState("input", key, value)
  }
  const prepare = async () => {
    if (!alive || blocked() || pending() || state.result) return
    const request = installationRequest(props.intent, state.input)
    if (!request) {
      setState("error", "config.extensions.install.invalid")
      return
    }
    const ticket = ++serial
    const operations = props.operations
    setState({ phase: "preparing", error: undefined, acceptRegistryUpgrade: false })
    try {
      const prepared = await operations.prepareInstallation(request)
      if (!current(ticket) || invalidated()) {
        void operations.cancelInstallation(prepared).catch(() => {})
        return
      }
      owned = { prepared, operations, submitted: false }
      setState({ phase: "preview", prepared, enable: false })
    } catch {
      if (current(ticket)) setState({ phase: "edit", error: "config.extensions.install.failed" })
    }
  }
  const finish = (result: InstallationResult, prepared: PreparedInstallation) => {
    const safe = installationPublicResult(result, prepared.token)
    setState({ result: safe, phase: "result", error: undefined })
    props.onResult?.(safe)
  }
  const commit = async () => {
    const operation = owned
    if (
      !alive ||
      blocked() ||
      state.phase !== "preview" ||
      !operation ||
      (operation.prepared.registryUpgrade && !state.acceptRegistryUpgrade)
    )
      return
    const expiresAt = Number(operation.prepared.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      cancelOwned()
      setState({ phase: "edit", prepared: undefined, error: "config.extensions.install.expired" })
      return
    }
    const ticket = ++serial
    operation.submitted = true
    setState({ phase: "committing", error: undefined })
    try {
      const result = await operation.operations.commitInstallation(operation.prepared, {
        enable: state.enable,
        ...(operation.prepared.registryUpgrade ? { acceptRegistryUpgrade: state.acceptRegistryUpgrade } : {}),
      })
      if (current(ticket)) finish(result, operation.prepared)
    } catch {
      // A lost response is not proof that the registry write failed. Keep the capability for status, never retry install.
      if (current(ticket)) finish(installationUnknown(operation.prepared), operation.prepared)
    }
  }
  const status = async () => {
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
      } else finish(result, operation.prepared)
    } catch {
      if (current(ticket)) setState({ phase: "result", error: "config.extensions.install.statusFailed" })
    }
  }
  const back = () => {
    if (pending() || state.result) return
    serial++
    cancelOwned()
    setState({ phase: "edit", prepared: undefined, error: undefined })
  }
  const list = (title: InstallationTranslationKey, values: string[]) => (
    <section class="flex flex-col gap-1">
      <h3 class="text-13-medium text-text-strong">{t(title)}</h3>
      <Show when={values.length} fallback={<p>{t("config.extensions.install.none")}</p>}>
        <ul class="list-disc pl-5">
          <For each={values}>{(value) => <li class="break-all">{value}</li>}</For>
        </ul>
      </Show>
    </section>
  )
  return (
    <div
      class="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-5 pb-5 text-13-regular text-text-base"
      data-extension-install={props.intent.kind}
    >
      <Show when={blocked() && !state.stale}>
        <p role="status">{t("config.extensions.install.blocked")}</p>
      </Show>
      <Show when={state.error}>
        {(error) => (
          <p role="alert" class="text-text-danger-base">
            {t(error())}
          </p>
        )}
      </Show>
      <Show when={(state.phase === "edit" || state.phase === "preparing") && !state.result}>
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
              <Show when={state.input.purgeData}>
                <p role="alert" class="text-text-danger-base">
                  {t("config.extensions.install.purgeWarning")}
                </p>
              </Show>
            </>
          }
        >
          <label class="flex flex-col gap-2">
            {t("config.extensions.install.source")}
            <select
              data-field="source-type"
              class="rounded border border-border-weak-base bg-surface-base p-2"
              value={state.input.sourceType}
              disabled={blocked() || releaseUpdate()}
              onChange={(event) => edit("sourceType", event.currentTarget.value as InstallationInput["sourceType"])}
            >
              <option value="release">{t("config.extensions.install.release")}</option>
              <option value="npm">{t("config.extensions.install.npm")}</option>
              <option value="archive">{t("config.extensions.install.archive")}</option>
              <Show when={localInstall()}>
                <option value="local">{t("config.extensions.install.local")}</option>
              </Show>
              <Show when={npmUpdate()}>
                <option value="version">{t("config.extensions.install.version")}</option>
              </Show>
            </select>
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
              disabled={blocked() || pending() || (state.input.sourceType === "local" && !digestConfirmed())}
              onClick={() => void prepare()}
            >
              {t(pending() ? "config.extensions.install.busy" : "config.extensions.install.preview")}
            </Button>
          </div>
          <Show when={state.input.sourceType === "archive" || state.input.sourceType === "local"}>
            <div class="flex flex-col gap-1" data-field="installation-sha256">
              <TextField
                aria-label={t("config.extensions.install.sha256")}
                label={t("config.extensions.install.sha256")}
                value={state.input.sha256}
                disabled={blocked()}
                onChange={(value) => edit("sha256", value)}
              />
              <Show when={state.input.sourceType === "local"}>
                <Show
                  when={state.localDigest}
                  fallback={
                    <p data-field="local-digest" class="text-12-regular text-text-weak">
                      {state.localDigestError
                        ? t("config.extensions.install.failed")
                        : t("config.extensions.install.localDigestPending")}
                    </p>
                  }
                >
                  <p data-field="local-digest" class="text-12-regular text-text-weak">
                    {t("config.extensions.install.localDigestComputed")}:{" "}
                    <code class="break-all font-mono">{state.localDigest}</code>
                  </p>
                  <p
                    data-field="local-digest-state"
                    class="text-12-regular"
                    classList={{
                      "text-text-success-base": digestConfirmed(),
                      "text-text-danger-base": !digestConfirmed() && state.input.sha256.length > 0,
                      "text-text-weak": !digestConfirmed() && state.input.sha256.length === 0,
                    }}
                  >
                    {digestConfirmed()
                      ? t("config.extensions.install.localDigestMatch")
                      : t("config.extensions.install.localDigestMismatch")}
                  </p>
                </Show>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>
      <Show when={!state.result ? state.prepared : undefined}>
        {(prepared) => (
          <>
            <div class="rounded-lg border border-border-weak-base p-3">
              <h2 class="text-16-medium text-text-strong">{prepared().name}</h2>
              <p class="break-all">{prepared().id}</p>
              <p data-preview="versions">
                {prepared().oldVersion ? `${prepared().oldVersion} → ` : ""}
                {prepared().version}
              </p>
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
            </div>
            <section>
              <h3 class="text-13-medium text-text-strong">{t("config.extensions.install.source")}</h3>
              <p class="break-all">
                {state.input.sourceType === "local"
                  ? state.input.localPath
                  : installationSourceLabel(prepared().source)}
              </p>
            </section>
            <Show when={prepared().source.type === "release"}>
              <section data-preview="release-integrity" class="flex flex-col gap-1">
                <h3 class="text-13-medium text-text-strong">{t("config.extensions.install.downloadHost")}</h3>
                <p class="break-all">{installationDownloadHost(prepared().source)}</p>
                <p>{t("config.extensions.install.integrityMatched")}</p>
                <p>{t("config.extensions.install.publisherUnsigned")}</p>
              </section>
            </Show>
            <p role="alert" data-preview="trust" class="text-text-danger-base">
              {t("config.extensions.install.unverified")}
            </p>
            <Show when={prepared().hasServer}>
              <p>{t("config.extensions.install.serverWarning")}</p>
            </Show>
            {list("config.extensions.install.permissions", prepared().permissions)}
            {list("config.extensions.install.permissionsAdded", prepared().permissionsAdded)}
            {list("config.extensions.install.permissionsRemoved", prepared().permissionsRemoved)}
            <section data-preview="contributes">
              <h3 class="text-13-medium text-text-strong">{t("config.extensions.install.contributes")}</h3>
              <For each={["fileViewers", "toolRenderers", "commands", "panels", "settings"] as const}>
                {(key) => (
                  <p>
                    {t(`config.extensions.install.${key}`)}:{" "}
                    {key === "settings"
                      ? Object.keys(prepared().contributes.settings ?? {}).length
                      : (prepared().contributes[key]?.length ?? 0)}
                  </p>
                )}
              </For>
            </section>
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
            <Show when={prepared().kind === "uninstall"}>
              <p role={state.input.purgeData ? "alert" : "status"}>
                {t(
                  state.input.purgeData
                    ? "config.extensions.install.purgeWarning"
                    : "config.extensions.install.keepData",
                )}
              </p>
            </Show>
            <Show when={prepared().registryUpgrade}>
              <section data-preview="registry-upgrade" class="flex flex-col gap-2">
                <p role="alert">{t("config.extensions.install.registryUpgradeWarning")}</p>
                <Checkbox
                  data-field="accept-registry-upgrade"
                  checked={state.acceptRegistryUpgrade}
                  disabled={blocked() || pending()}
                  onChange={(value) => setState("acceptRegistryUpgrade", value)}
                >
                  {t("config.extensions.install.acceptRegistryUpgrade")}
                </Checkbox>
              </section>
            </Show>
            <div class="flex justify-end gap-2">
              <Button data-action="extension-install-back" disabled={pending()} onClick={back}>
                {t("config.extensions.install.back")}
              </Button>
              <Button
                data-action="extension-install-confirm"
                variant="primary"
                disabled={blocked() || pending() || (!!prepared().registryUpgrade && !state.acceptRegistryUpgrade)}
                onClick={() => void commit()}
              >
                {t(pending() ? "config.extensions.install.busy" : "config.extensions.install.confirm")}
              </Button>
            </div>
          </>
        )}
      </Show>
      <Show when={state.result}>
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
      <div class="flex justify-end gap-2">
        <Show
          when={
            props.intent.kind === "uninstall" &&
            (state.phase === "edit" || state.phase === "preparing") &&
            !state.result
          }
        >
          <Button
            size="small"
            data-action="extension-install-prepare"
            disabled={blocked() || pending()}
            onClick={() => void prepare()}
          >
            {t(pending() ? "config.extensions.install.busy" : "config.extensions.install.preview")}
          </Button>
        </Show>
        <Button data-action="extension-install-close" onClick={close}>
          {t(state.result ? "config.extensions.install.close" : "config.extensions.install.cancel")}
        </Button>
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
