import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useSessionTabs } from "@/context/session-tabs"
import { domainFromDirectory } from "@/pages/layout/extra-agents"
import { setSessionHandoff } from "@/pages/session/handoff"
import { sessionExcerpt } from "@/components/prompt-input/session-reference"

export function useNewSessionWithReference() {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const tabs = useSessionTabs()
  const [state, setState] = createStore({ pending: false })

  const create = async (source: { id: string; directory: string }) => {
    if (state.pending) return
    setState("pending", true)
    const { id, directory } = source
    try {
      console.debug(`[session-reference-new] load id=${id} directory=${directory}`)
      const client = sdk.forDomain(domainFromDirectory(directory)).createClient({ directory, throwOnError: true })
      const session = await client.session.get({ sessionID: id })
      if (!session.data) throw new Error(language.t("prompt.session.unavailable"))
      console.debug(`[session-reference-new] metadata loaded id=${id}`)
      const messages = await client.session.messages({ sessionID: id, limit: 10 })
      console.debug(`[session-reference-new] messages loaded id=${id} count=${messages.data?.length ?? 0}`)
      const draft = tabs.createDraft(directory, "menu")
      setSessionHandoff(`${base64Encode(directory)}/${draft.id}`, {
        context: [
          {
            type: "session",
            sessionID: id,
            directory,
            title: session.data.title,
            updatedAt: session.data.time.updated,
            summary: sessionExcerpt(messages.data ?? []),
          },
        ],
      })
      console.debug(`[session-reference-new] staged id=${id} draft=${draft.id}`)
      const result = await tabs.activate({ type: "draft", ...draft })
      console.debug(`[session-reference-new] activation id=${id} draft=${draft.id} result=${result}`)
      if (result === "failed") throw new Error(language.t("prompt.session.unavailable"))
    } catch (error) {
      console.warn(`[session-reference-new] failed id=${id} directory=${directory} error=${String(error)}`)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("prompt.session.unavailable"),
      })
    } finally {
      setState("pending", false)
    }
  }

  return { pending: () => state.pending, create }
}
