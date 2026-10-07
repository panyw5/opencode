import en from "../../resources/gpt-pro-login/_locales/en/messages.json"
import zhCN from "../../resources/gpt-pro-login/_locales/zh_CN/messages.json"
import zhTW from "../../resources/gpt-pro-login/_locales/zh_TW/messages.json"
import ja from "../../resources/gpt-pro-login/_locales/ja/messages.json"
import ko from "../../resources/gpt-pro-login/_locales/ko/messages.json"
import de from "../../resources/gpt-pro-login/_locales/de/messages.json"
import fr from "../../resources/gpt-pro-login/_locales/fr/messages.json"
import es from "../../resources/gpt-pro-login/_locales/es/messages.json"

const catalogs = { en, zh_CN: zhCN, zh_TW: zhTW, ja, ko, de, fr, es }
type Locale = keyof typeof catalogs

export const escapeLoginHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

export function resolveLoginLocale(acceptLanguage = ""): Locale {
  const preferences = acceptLanguage
    .slice(0, 4096)
    .split(",")
    .slice(0, 32)
    .map((entry, index) => {
      const [tag, ...parameters] = entry.trim().toLowerCase().replaceAll("_", "-").split(";")
      const parameter = parameters.find((value) => value.trim().startsWith("q="))
      const quality = parameter ? Number(parameter.trim().slice(2)) : 1
      return { tag, quality, index }
    })
    .filter((entry) => Number.isFinite(entry.quality) && entry.quality > 0 && entry.quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
  for (const { tag } of preferences) {
    if (tag === "*") return "en"
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(tag)) continue
    const [language, ...parts] = tag.split("-")
    if (language === "zh") {
      if (parts.includes("hant")) return "zh_TW"
      if (parts.includes("hans")) return "zh_CN"
      return parts.some((part) => ["tw", "hk", "mo"].includes(part)) ? "zh_TW" : "zh_CN"
    }
    if (Object.hasOwn(catalogs, language)) return language as Locale
  }
  return "en"
}

export function renderLoginPage(acceptLanguage: string | undefined, extensionDirectory: string) {
  const locale = resolveLoginLocale(acceptLanguage)
  const messages = catalogs[locale]
  const t = (key: keyof typeof en) => escapeLoginHtml(messages[key].message)
  // Only our own fixed markup can replace placeholders; translations and paths stay escaped.
  const format = (key: keyof typeof en, markup: Record<string, string>) =>
    t(key).replace(/\{(\w+)\}/g, (original, token: string) => (Object.hasOwn(markup, token) ? markup[token] : original))
  const strong = (key: keyof typeof en) => `<strong>${t(key)}</strong>`
  const title = t("connectionPageTitle")
  const language = locale.replace("_", "-")
  const steps = [
    format("connectionStepExtensions", {
      extensions: "<code>chrome://extensions</code>",
      mode: strong("connectionDeveloperMode"),
    }),
    format("connectionStepLoad", { load: strong("connectionLoadUnpacked") }) +
      `<pre>${escapeLoginHtml(extensionDirectory)}</pre>`,
    format("connectionStepLogin", {
      chatgpt: `<a href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">${t("connectionChatLink")}</a>`,
    }),
    format("connectionStepReturn", { page: title, extension: strong("extensionName") }),
    format("connectionStepApprove", { consent: strong("connectionConsent"), connect: strong("connect") }),
  ]
  return {
    language,
    html: `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/style.css"></head><body><main>
<p class="eyebrow">${t("connectionEyebrow")}</p>
<h1>${title}</h1>
<ol>${steps.map((step) => `<li>${step}</li>`).join("\n")}</ol>
</main></body></html>`,
  }
}
