import { GptProOperationError } from "@opencode-ai/util/gpt-pro-error"
import type { GptProController } from "./gpt-pro-controller"
import type { BrowserController } from "./browser"
import type { getGptProCredentials } from "./gpt-pro-credentials"
import type { GptProSessionCoordinator } from "./gpt-pro-session-coordinator"
import type { SessionCookie } from "./gpt-pro-session-cookies"
import { openGptProCandidatePage } from "./gpt-pro-page-manager"

type Dependencies = {
  controller: Pick<GptProController, "importLogin" | "promoteLoginProfile" | "assertLoginAccount">
  credentials: Pick<
    ReturnType<typeof getGptProCredentials>,
    "ready" | "profileID" | "collect" | "stage" | "promote" | "retain"
  >
  browser: Pick<BrowserController, "has" | "openPage" | "getState" | "cdp">
  coordinator(profileID: string): GptProSessionCoordinator
  changed(): void
  log(message: string): void
}

export class GptProLoginTransaction {
  private pending?: string
  constructor(private deps: Dependencies) {}
  pendingProfileID() {
    return this.pending
  }
  profileReleased(id: string) {
    if (this.pending !== id) return
    this.pending = undefined
    this.deps.changed()
  }
  async import(cookies: SessionCookie[]) {
    await this.run(async () => {
      await this.deps.credentials.collect((id) => this.deps.browser.getState().some((view) => view.profileID === id))
      const id = await this.deps.credentials.stage(cookies)
      this.pending = id
      this.deps.changed()
      await this.verifyCandidate(id)
    })
  }
  async verify() {
    const id = this.pending
    if (!id)
      throw new GptProOperationError(
        "login_import_failed",
        "There is no pending login candidate. Import a login first.",
      )
    await this.run(() => this.verifyCandidate(id))
  }
  private async run(action: () => Promise<void>) {
    await this.deps.controller.importLogin(() =>
      this.deps.coordinator(this.deps.credentials.profileID()).importCredentials(async () => {
        await this.deps.credentials.ready()
        await action()
      }),
    )
  }
  private async verifyCandidate(id: string) {
    const { browser, credentials, controller } = this.deps
    const coordinator = this.deps.coordinator(id)
    try {
      const previous = coordinator.snapshot().authentication
      if (previous.retryAt && previous.retryAt > Date.now())
        throw new GptProOperationError(
          "login_import_pending",
          "ChatGPT requested authentication backoff. Wait before explicitly verifying this candidate again; credentials were retained.",
        )
      await coordinator.importCredentials(async () => {
        await openGptProCandidatePage(browser, id, this.deps.log)
      }, true)
      const evidence = coordinator.snapshot().authentication
      coordinator.assertAuthentication(evidence)
      controller.assertLoginAccount(evidence.accountID!)
      this.deps.log(`login candidate verified profile=${id}; checking execution bindings before promotion`)
      await credentials.promote(id, () => {
        coordinator.assertAuthentication(evidence)
        controller.promoteLoginProfile(id, evidence.accountID!)
      })
      this.pending = undefined
      this.deps.changed()
      // Retire only jars whose pages have already been closed. Never clear another profile's drafts.
      await credentials
        .collect((profile) => browser.getState().some((view) => view.profileID === profile))
        .catch(() => {
          this.deps.log("retired credential profile cleanup deferred; active promotion remains committed")
        })
    } catch (error) {
      credentials.retain(id)
      await credentials
        .collect((profile) => browser.getState().some((view) => view.profileID === profile))
        .catch(() => {
          this.deps.log("failed candidate cleanup deferred; retained profiles remain bounded")
        })
      this.deps.log(
        `login candidate retained profile=${id}; active login and all old pages unchanged, explicit verification required`,
      )
      this.deps.changed()
      throw error
    }
  }
}
