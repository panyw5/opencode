import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"

export function PanelCollapseButton(props: { panel: "browser" | "review" | "filePreview" }) {
  const layout = useLayout()
  const language = useLanguage()

  const collapse = () => {
    console.debug(`[right-panel] collapse button panel=${props.panel}`)
    layout.rightPanel.select("none")
  }

  return (
    <Tooltip placement="bottom" value={language.t("session.panel.collapse")}>
      <IconButton
        icon="panel-right-close"
        variant="ghost"
        class="h-7 w-7 shrink-0"
        onClick={collapse}
        aria-label={language.t("session.panel.collapse")}
        data-action="right-panel-collapse"
      />
    </Tooltip>
  )
}
