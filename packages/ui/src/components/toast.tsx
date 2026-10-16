import { Toast as Kobalte, toaster } from "@kobalte/core/toast"
import type { ToastRootProps, ToastCloseButtonProps, ToastTitleProps, ToastDescriptionProps } from "@kobalte/core/toast"
import type { ComponentProps, JSX } from "solid-js"
import { Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { Icon, type IconProps } from "./icon"
import { IconButton } from "./icon-button"
import { ToastV2, showToastV2 } from "../v2/components/toast-v2"

export interface ToastRegionProps extends ComponentProps<typeof Kobalte.Region> {}

function ToastRegion(props: ToastRegionProps) {
  return <ToastV2.Region {...props} />
}

export interface ToastRootComponentProps extends ToastRootProps {
  class?: string
  classList?: ComponentProps<"li">["classList"]
  children?: JSX.Element
}

function ToastRoot(props: ToastRootComponentProps) {
  return (
    <Kobalte
      data-component="toast"
      classList={{
        ...(props.classList ?? {}),
        [props.class ?? ""]: !!props.class,
      }}
      {...props}
    />
  )
}

function ToastIcon(props: { name: IconProps["name"]; size?: IconProps["size"] }) {
  return (
    <div data-slot="toast-icon">
      <Icon name={props.name} size={props.size} />
    </div>
  )
}

function ToastContent(props: ComponentProps<"div">) {
  return <div data-slot="toast-content" {...props} />
}

function ToastTitle(props: ToastTitleProps & ComponentProps<"div">) {
  return <Kobalte.Title data-slot="toast-title" {...props} />
}

function ToastDescription(props: ToastDescriptionProps & ComponentProps<"div">) {
  return <Kobalte.Description data-slot="toast-description" {...props} />
}

function ToastActions(props: ComponentProps<"div">) {
  return <div data-slot="toast-actions" {...props} />
}

function ToastCloseButton(props: ToastCloseButtonProps & ComponentProps<"button">) {
  const i18n = useI18n()
  return (
    <Kobalte.CloseButton
      data-slot="toast-close-button"
      as={IconButton}
      icon="close"
      variant="ghost"
      aria-label={i18n.t("ui.common.dismiss")}
      {...props}
    />
  )
}

function ToastProgressTrack(props: ComponentProps<typeof Kobalte.ProgressTrack>) {
  return <Kobalte.ProgressTrack data-slot="toast-progress-track" {...props} />
}

function ToastProgressFill(props: ComponentProps<typeof Kobalte.ProgressFill>) {
  return <Kobalte.ProgressFill data-slot="toast-progress-fill" {...props} />
}

function ToastCountdown() {
  return (
    <ToastProgressTrack data-slot="toast-countdown">
      <ToastProgressFill data-slot="toast-countdown-fill" />
    </ToastProgressTrack>
  )
}

export const Toast = Object.assign(ToastRoot, {
  Region: ToastRegion,
  Icon: ToastIcon,
  Content: ToastContent,
  Title: ToastTitle,
  Description: ToastDescription,
  Actions: ToastActions,
  CloseButton: ToastCloseButton,
  Countdown: ToastCountdown,
  ProgressTrack: ToastProgressTrack,
  ProgressFill: ToastProgressFill,
})

export { toaster }

export type ToastVariant = "default" | "success" | "error" | "loading"

export interface ToastAction {
  label: string
  onClick: "dismiss" | (() => void)
}

export interface ToastOptions {
  title?: string
  description?: string
  icon?: IconProps["name"]
  variant?: ToastVariant
  duration?: number
  persistent?: boolean
  actions?: ToastAction[]
}

export function showToast(options: ToastOptions | string) {
  const opts = typeof options === "string" ? { description: options } : options
  const icon =
    opts.icon ??
    (opts.variant === "success" ? "check-small" : opts.variant === "error" ? "circle-exclamation" : undefined)
  return showToastV2({
    title: opts.title,
    description: opts.description,
    variant: opts.variant,
    duration: opts.duration,
    persistent: opts.persistent,
    icon: icon ? <Icon name={icon} /> : undefined,
    actions: opts.actions?.map((action) => ({ ...action, variant: "primary" as const })),
  })
}

export interface CompactToastOptions {
  icon: IconProps["name"]
  title: string
  duration?: number
  goLabel?: string
  dismissLabel?: string
  onGo?: () => void
}

// Compact two-row action toast: the type icon sits alone in a left column;
// the right column holds the truncated title on row 1 and the "go" arrow
// button + countdown-ring dismiss control on row 2 (left-aligned with the
// title). No close button, no type text.
export function showCompactToast(options: CompactToastOptions) {
  const duration = options.duration ?? 3000
  return toaster.show((props) => (
    <Toast toastId={props.toastId} duration={duration} data-variant="default" data-compact>
      <Toast.Content>
        <div data-slot="toast-compact-body">
          <Toast.Icon
            name={options.icon}
            size={options.icon === "question-mark" || options.icon === "shield-check" ? "medium" : undefined}
          />
          <div data-slot="toast-compact-main">
            <span data-slot="toast-compact-title">{options.title}</span>
            <div data-slot="toast-compact-row">
              <button
                type="button"
                data-slot="toast-compact-go"
                aria-label={options.goLabel}
                onClick={() => {
                  options.onGo?.()
                  toaster.dismiss(props.toastId)
                }}
              >
                <Icon name="arrow-right" />
                <span data-slot="toast-compact-label">{options.goLabel}</span>
              </button>
              <button
                type="button"
                data-slot="toast-compact-dismiss"
                aria-label={options.dismissLabel}
                onClick={() => toaster.dismiss(props.toastId)}
              >
                <Toast.Countdown />
                <span data-slot="toast-compact-label">{options.dismissLabel}</span>
              </button>
            </div>
          </div>
        </div>
      </Toast.Content>
    </Toast>
  ))
}

export interface ToastPromiseOptions<T, U = unknown> {
  loading?: JSX.Element
  success?: (data: T) => JSX.Element
  error?: (error: U) => JSX.Element
}

export function showPromiseToast<T, U = unknown>(
  promise: Promise<T> | (() => Promise<T>),
  options: ToastPromiseOptions<T, U>,
) {
  return toaster.promise(promise, (props) => (
    <ToastV2
      toastId={props.toastId}
      data-variant={props.state === "pending" ? "loading" : props.state === "fulfilled" ? "success" : "error"}
    >
      <div data-slot="toast-v2-header">
        <ToastV2.Icon>
          <Icon
            name={
              props.state === "pending"
                ? "arrow-sync"
                : props.state === "fulfilled"
                  ? "check-small"
                  : "circle-exclamation"
            }
          />
        </ToastV2.Icon>
        <ToastV2.Content>
          <ToastV2.Description>
            {props.state === "pending" && options.loading}
            {props.state === "fulfilled" && options.success?.(props.data!)}
            {props.state === "rejected" && options.error?.(props.error)}
          </ToastV2.Description>
        </ToastV2.Content>
        <div data-slot="toast-v2-controls">
          <Show when={props.state !== "pending"}>
            <ToastV2.Countdown />
          </Show>
          <ToastV2.CloseButton />
        </div>
      </div>
    </ToastV2>
  ))
}
