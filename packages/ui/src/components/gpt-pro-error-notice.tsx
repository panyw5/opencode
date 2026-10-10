import { Show } from "solid-js"
import { gptProDiagnostic, gptProIssue, type GptProIssueContext } from "@opencode-ai/util/gpt-pro-error"
import { Button } from "./button"
import { useI18n } from "../context/i18n"

export function GptProErrorNotice(props: GptProIssueContext & { busy?: boolean; onOpenPage?: () => void }) {
  const t = useI18n().t
  const issue = () => gptProIssue(props)
  const details = () => gptProDiagnostic(props.error)
  const canOpen = () =>
    props.onOpenPage &&
    !["disabled", "owner_busy", "page_capacity", "queue_capacity", "cancelled"].includes(issue()?.code ?? "")
  return (
    <Show when={issue()}>
      {(current) => (
        <section
          data-component="gpt-pro-error-notice"
          data-error-code={current().code}
          data-tone={current().tone}
          role={current().tone === "info" ? "status" : "alert"}
        >
          <p class="gpt-pro-error-notice__title">{t(`ui.tool.gptPro.error.${current().code}.title`)}</p>
          <p class="gpt-pro-error-notice__hint">{t(`ui.tool.gptPro.error.${current().code}.hint`)}</p>
          <Show when={canOpen()}>
            <Button size="small" variant="secondary" disabled={props.busy} onClick={() => props.onOpenPage?.()}>
              {t("ui.tool.gptPro.openOriginal")}
            </Button>
          </Show>
          <Show when={details()}>
            <details>
              <summary>{t("ui.tool.gptPro.error.details")}</summary>
              <pre>{details()}</pre>
            </details>
          </Show>
        </section>
      )}
    </Show>
  )
}
