export function codeFileLanguage(name: string) {
  const base = name.split(/[\\/]/).pop() ?? name
  const lower = base.toLowerCase()
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower
  const aliases: Record<string, string> = {
    bash: "zsh",
    cjs: "javascript",
    cls: "tex",
    conf: "nginx",
    cpp: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    hxx: "cpp",
    js: "javascript",
    jsonl: "jsonl",
    jsx: "jsx",
    mjs: "javascript",
    mma: "wolfram",
    nb: "wolfram",
    py: "python",
    pyi: "python",
    pyw: "python",
    rb: "ruby",
    sh: "zsh",
    ts: "typescript",
    tsx: "tsx",
    wl: "wolfram",
    wls: "wolfram",
    yaml: "yaml",
    yml: "yaml",
    zsh: "zsh",
  }
  return aliases[lower] ?? aliases[ext] ?? ext
}
