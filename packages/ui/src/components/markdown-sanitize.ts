import DOMPurify from "dompurify"

export function createMarkdownSanitizer(window?: Parameters<typeof DOMPurify>[0]) {
  // Keep both hooks and parsed allow-lists private to Markdown, not other consumers.
  const purifier = DOMPurify(window)
  if (purifier.isSupported) {
    purifier.setConfig({
      USE_PROFILES: { html: true, svg: true, mathMl: true },
      SANITIZE_NAMED_PROPS: true,
      FORBID_TAGS: ["style"],
      FORBID_CONTENTS: ["style", "script"],
    })
    purifier.addHook("afterSanitizeAttributes", (node) => {
      if (node.nodeName.toLowerCase() !== "a" || node.getAttribute("target") !== "_blank") return
      const rel = new Set((node.getAttribute("rel") ?? "").split(/\s+/).filter(Boolean))
      rel.add("noopener")
      rel.add("noreferrer")
      node.setAttribute("rel", [...rel].join(" "))
    })
  }
  return (html: string) => (purifier.isSupported ? purifier.sanitize(html) : "")
}

export const sanitizeMarkdown = createMarkdownSanitizer(typeof window === "undefined" ? undefined : window)
