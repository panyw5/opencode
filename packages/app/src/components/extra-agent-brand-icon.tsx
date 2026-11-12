import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import hermesIcon from "../../../ui/src/assets/icons/agent/hermes.png"
import genericagentIcon from "../../../ui/src/assets/icons/agent/genericagent.jpg"

/** Official brand marks for the external-agent cards on the config page. */
export function ExtraAgentBrandIcon(props: { id: string }) {
  const vector = "size-[18px] shrink-0"
  if (props.id === "openclaw") return <Icon name="openclaw" size="medium" />
  // Official NousResearch nous-girl mark; black line art needs the light tile variant.
  if (props.id === "hermes")
    return (
      <span class="flex size-full items-center justify-center rounded-md bg-white">
        <img src={hermesIcon} alt="" aria-hidden="true" class="size-6 object-contain" />
      </span>
    )
  // Official lsdefine/GenericAgent logo (logo.jpg).
  if (props.id === "genericagent")
    return <img src={genericagentIcon} alt="" aria-hidden="true" class="size-full rounded-md object-cover" />
  if (props.id === "gpt-pro" || props.id === "codex")
    return <ProviderIcon id="openai" class={vector} aria-hidden="true" />
  // Official pi.dev logo (pi.dev/logo-auto.svg).
  if (props.id === "pi")
    return (
      <svg viewBox="165.29 165.29 469.43 469.43" class={vector} aria-hidden="true">
        <path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
        <path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z" />
        <path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z" />
      </svg>
    )
  // Official Claude starburst from the claude.com wordmark.
  if (props.id === "claude")
    return (
      <svg viewBox="0 0 125 125" class={vector} aria-hidden="true">
        <path
          fill="#D97757"
          d="M54.375 118.75L56.125 111L58.125 101L59.75 93L61.25 83.125L62.125 79.875L62 79.625L61.375 79.75L53.875 90L42.5 105.375L33.5 114.875L31.375 115.75L27.625 113.875L28 110.375L30.125 107.375L42.5 91.5L50 81.625L54.875 76L54.75 75.25H54.5L21.5 96.75L15.625 97.5L13 95.125L13.375 91.25L14.625 90L24.5 83.125L49.125 69.375L49.5 68.125L49.125 67.5H47.875L43.75 67.25L29.75 66.875L17.625 66.375L5.75 65.75L2.75 65.125L0 61.375L0.25 59.5L2.75 57.875L6.375 58.125L14.25 58.75L26.125 59.5L34.75 60L47.5 61.375H49.5L49.75 60.5L49.125 60L48.625 59.5L36.25 51.25L23 42.5L16 37.375L12.25 34.75L10.375 32.375L9.625 27.125L13 23.375L17.625 23.75L18.75 24L23.375 27.625L33.25 35.25L46.25 44.875L48.125 46.375L49 45.875V45.5L48.125 44.125L41.125 31.375L33.625 18.375L30.25 13L29.375 9.75C29.0417 8.625 28.875 7.375 28.875 6L32.75 0.750006L34.875 0L40.125 0.750006L42.25 2.625L45.5 10L50.625 21.625L58.75 37.375L61.125 42.125L62.375 46.375L62.875 47.75H63.75V47L64.375 38L65.625 27.125L66.875 13.125L67.25 9.125L69.25 4.375L73.125 1.87501L76.125 3.25L78.625 6.875L78.25 9.125L76.875 18.75L73.875 33.875L72 44.125H73.125L74.375 42.75L79.5 36L88.125 25.25L91.875 21L96.375 16.25L99.25 14H104.625L108.5 19.875L106.75 26L101.25 33L96.625 38.875L90 47.75L86 54.875L86.375 55.375H87.25L102.125 52.125L110.25 50.75L119.75 49.125L124.125 51.125L124.625 53.125L122.875 57.375L112.625 59.875L100.625 62.25L82.75 66.5L82.5 66.625L82.75 67L90.75 67.75L94.25 68H102.75L118.5 69.125L122.625 71.875L125 75.125L124.625 77.75L118.25 80.875L109.75 78.875L89.75 74.125L83 72.5H82V73L87.75 78.625L98.125 88L111.25 100.125L111.875 103.125L110.25 105.625L108.5 105.375L97 96.625L92.5 92.75L82.5 84.375H81.875V85.25L84.125 88.625L96.375 107L97 112.625L96.125 114.375L92.875 115.5L89.5 114.875L82.25 104.875L74.875 93.5L68.875 83.375L68.25 83.875L64.625 121.625L63 123.5L59.25 125L56.125 122.625L54.375 118.75Z"
        />
      </svg>
    )
  // Official Grok mark from grok.com (#mark).
  if (props.id === "grok")
    return (
      <svg viewBox="0 0 34 33" class={vector} aria-hidden="true">
        <path
          fill="currentColor"
          d="M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436"
        />
        <path
          fill="currentColor"
          d="M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341"
        />
      </svg>
    )
  if (props.id === "dsh")
    return <ProviderIcon id="deepseek" class={vector} style={{ color: "#4D6BFE" }} aria-hidden="true" />
  return <Icon name="code" size="small" />
}