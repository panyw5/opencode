import { createMemo, For, Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { BasicTool, GenericTool } from "./basic-tool"
import type { ToolProps } from "./message-part"
import { codeModeTitle, readMcpCodeModeCalls } from "./mcp-code-mode"

export function McpCodeModeTool(props: ToolProps) {
  const i18n = useI18n()
  const calls = createMemo(() => readMcpCodeModeCalls(props.metadata))
  const status = (value: string) =>
    value === "completed"
      ? i18n.t("ui.tool.codemode.completed")
      : value === "error"
        ? i18n.t("ui.tool.codemode.error")
        : i18n.t("ui.tool.codemode.running")
  return (
    <Show when={props.metadata.codemode === true} fallback={<GenericTool {...props} />}>
      <BasicTool
        {...props}
        icon="console"
        showPendingDetails
        showPendingMeta
        hasDetails
        trigger={{
          title: codeModeTitle(props.metadata),
          subtitle: i18n.t(
            props.metadata.codemodeScope === "query" ? "ui.tool.codemode.queryCalls" : "ui.tool.codemode.calls",
            { count: calls().length },
          ),
        }}
      >
        <div data-slot="mcp-codemode-details" class="flex flex-col gap-3 p-3">
          <Show when={typeof props.input.code === "string"}>
            <pre data-component="tool-input" class="overflow-auto whitespace-pre-wrap text-12-regular">
              <code>{props.input.code}</code>
            </pre>
          </Show>
          <For each={calls()}>
            {(call) => (
              <details data-slot="mcp-codemode-call" data-status={call.status}>
                <summary class="flex cursor-pointer items-center justify-between gap-3 text-12-regular">
                  <span class="truncate font-mono">{call.tool}</span>
                  <span class="shrink-0 text-text-weak">{status(call.status)}</span>
                </summary>
                <Show when={call.input}>
                  <pre class="overflow-auto whitespace-pre-wrap p-2 text-12-regular">
                    <code>{call.input}</code>
                  </pre>
                </Show>
                <Show when={call.error}>
                  <div class="whitespace-pre-wrap p-2 text-12-regular text-text-weak">{call.error}</div>
                </Show>
              </details>
            )}
          </For>
          <Show when={props.output}>
            <pre data-component="tool-output" class="overflow-auto whitespace-pre-wrap text-12-regular">
              <code>{props.output}</code>
            </pre>
          </Show>
        </div>
      </BasicTool>
    </Show>
  )
}
