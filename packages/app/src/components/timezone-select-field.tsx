import { Select } from "@opencode-ai/ui/select"
import { createMemo, type JSX } from "solid-js"
import { timeZoneGroup, timeZoneOptions } from "@/utils/timezones"

export function TimezoneSelectField(props: {
  label: string
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  const options = createMemo(() => timeZoneOptions(props.value))
  const current = createMemo(() => {
    const value = props.value
    return options().includes(value) ? value : options()[0]
  })

  return (
    <label class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span class="shrink-0 text-12-medium text-text-weak">{props.label}</span>
      <div class="ml-auto max-w-full">
        <Select
          options={options()}
          current={current()}
          groupBy={timeZoneGroup}
          onSelect={(item) => item && props.onChange(item)}
          class="max-w-full"
        />
      </div>
    </label>
  )
}
