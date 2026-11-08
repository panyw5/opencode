export type ManagedAdvisor = "claude" | "codex" | "pi"
export type AdapterRelease = { version: string; integrity: string }
export type AdapterRecipe = {
  advisor: ManagedAdvisor
  package: string
  entry: string
  source: string
  loginHelp: string
  requires: string[]
  releases: AdapterRelease[]
}

// Reviewed, append-only releases. Never install a package/version supplied by a project or registry response.
export const adapterCatalog: AdapterRecipe[] = [
  {
    advisor: "claude",
    package: "@agentclientprotocol/claude-agent-acp",
    entry: "dist/index.js",
    source: "https://github.com/agentclientprotocol/claude-agent-acp",
    loginHelp: "Use an advertised ACP login method or authenticate Claude on this backend machine, then test again.",
    requires: ["Node.js >=22", "npm"],
    releases: [
      {
        version: "0.101.0",
        integrity: "sha512-c9YGBfdJrLcKiinRpXuDuibC+CRGqQpe9+ey/+TuuZ7ejHlVyEELbbvRkxHZN+Hf5XGecJD5i0kvP2opCseATA==",
      },
      {
        version: "0.100.0",
        integrity: "sha512-X+f2M5RiehzSzWRJjDSf0Sbzoc8JK66l85YnYW5TAdHJX53CLQV00v2M72bfCKJ4IZ11qt+WQ/Yg9NVKcuDAhQ==",
      },
    ],
  },
  {
    advisor: "codex",
    package: "@agentclientprotocol/codex-acp",
    entry: "dist/index.js",
    source: "https://github.com/agentclientprotocol/codex-acp",
    loginHelp: "Use an advertised ACP login method or run codex login on this backend machine, then test again.",
    requires: ["Node.js >=22", "npm"],
    releases: [
      {
        version: "2.5.0",
        integrity: "sha512-7e/4OhJwpvSTqsjiokoVYRV7O1XGem1CAsQgO1opmGYbRD5LvmydwDlJrldzQYO5TcPWueGzQ2Jdvyvp6l3qDw==",
      },
      {
        version: "2.4.0",
        integrity: "sha512-vpY1sFxVQ4t/5nq0XaiHOnXFitIhtaPEf+sVNSGxUuAS/c2p67o4PzW01vTsH88LH7tGRnv9N4WV4V8Jsag86A==",
      },
    ],
  },
  {
    advisor: "pi",
    package: "pi-acp",
    entry: "dist/index.js",
    source: "https://github.com/svkozak/pi-acp",
    loginHelp: "Authenticate Pi on this backend machine using its normal login flow, then test again.",
    requires: ["Node.js >=22", "npm", "Pi CLI (installed separately)"],
    releases: [
      {
        version: "0.0.34",
        integrity: "sha512-MrCp37UbpUzkTkzTIMJQf1RYrT+kr4fgGDGFoLmBN26UupuCZp0XxVIY+7XYsMo3yDnzDeZUJ0jPyM3Si6Bkkg==",
      },
      {
        version: "0.0.33",
        integrity: "sha512-vX9kY1tK14E72G4dBAx+RGCk/k7XPjTHls6dLUxA8WSkBav6B6JHuSBv3eusp50LCR/GTRsR2kIKsG0Z5jANzw==",
      },
    ],
  },
]
