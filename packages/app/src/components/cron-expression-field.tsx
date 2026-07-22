import { TextField } from "@opencode-ai/ui/text-field"
import { createMemo, type JSX } from "solid-js"
import { describeCronExpression } from "@/utils/cron-preview"

export function CronExpressionField(props: {
  label: string
  meaningLabel: string
  value: string
  timezone: string
  locale?: string
  onChange: (value: string) => void
}): JSX.Element {
  const preview = createMemo(() => describeCronExpression(props.value, props.locale, props.timezone))
  return (
    <div>
      <div class="mb-1 flex items-center justify-between gap-2">
        <span class="text-12-medium text-text-weak">{props.label}</span>
        <span class="text-11-regular text-text-weaker">{props.meaningLabel}</span>
      </div>
      <div class="flex min-w-0 items-stretch gap-2">
        <div class="min-w-0 flex-[0_1_11rem] max-w-[14rem]">
          <TextField
            hideLabel
            label={props.label}
            value={props.value}
            onChange={props.onChange}
            spellcheck={false}
            class="font-mono"
          />
        </div>
        <div
          class="flex min-h-8 min-w-0 flex-1 items-center rounded-md border border-border-weak-base bg-input-base px-3 py-0.5 font-mono text-[14px] leading-5"
          classList={{
            "text-text-strong": preview() !== "NA",
            "text-text-weaker": preview() === "NA",
          }}
          title={preview()}
        >
          <span class="whitespace-pre-wrap break-words">{preview()}</span>
        </div>
      </div>
    </div>
  )
}
