export const managedAdvisors = ["claude", "codex", "pi", "cline", "droid", "qoder", "devin"] as const
export type ManagedAdvisor = (typeof managedAdvisors)[number]
export type AdapterRelease = { version: string; integrity: string }
export type AdapterRecipe = {
  advisor: ManagedAdvisor
  package: string
  entry: string
  args?: string[]
  env?: Record<string, string>
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
    advisor: "cline",
    package: "cline",
    entry: "bin/cline",
    args: ["--acp"],
    source: "https://github.com/cline/cline",
    loginHelp: "Run cline auth on this backend machine or use an advertised ACP login method, then test again.",
    requires: ["Node.js >=22", "npm"],
    releases: [
      {
        version: "3.0.74",
        integrity: "sha512-pCaRaJ6Jx50Urej+BYjpGkpZnFbPDCPsibKEbIjEuVxETXbZ/A1SMij8Thy8FobercevXX6hV7joAzU7OG5lzA==",
      },
    ],
  },
  {
    advisor: "droid",
    package: "droid",
    entry: "bin/droid",
    args: ["exec", "--output-format", "acp-daemon"],
    env: { DROID_DISABLE_AUTO_UPDATE: "true", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
    source: "https://factory.ai/product/cli",
    loginHelp: "Use an advertised login method, run droid login, or set FACTORY_API_KEY on the backend machine.",
    requires: ["Node.js >=22", "npm", "A supported Factory Droid platform"],
    releases: [
      {
        version: "1.14.0",
        integrity: "sha512-fUTg44RQ8HrQOk3pv+nOv6R5FcnjbBLfqFXeU+cXUgTcpLYDhjxAvyrkPxffP764Jc6Tq8S+ucleM0/xBSaWuw==",
      },
    ],
  },
  {
    advisor: "qoder",
    package: "@qoder-ai/qodercli",
    entry: "bundle/qodercli.js",
    args: ["--acp"],
    source: "https://docs.qoder.com/cli/acp",
    loginHelp: "Run qodercli login on the backend machine using the same configuration directory, then test again.",
    requires: ["Node.js >=22", "npm", "A supported Qoder CLI platform"],
    releases: [
      {
        version: "1.1.92",
        integrity: "sha512-QZ+eEaMSW6ysqNyzDF0og+FwYh1BXBH5HjQc3pPxoDsgG9W5ml2BpTlT+VIURzLSbMgSqmFwrk/Y2BL8U4SBYA==",
      },
    ],
  },
  {
    advisor: "devin",
    package: "devin",
    entry: "bin/devin.js",
    args: ["acp"],
    source: "https://github.com/CognitionAI/devin-cli",
    loginHelp:
      "Use an advertised ACP login method, run `devin auth login`, or set WINDSURF_API_KEY on the backend machine, then test again.",
    requires: ["Node.js >=22", "npm", "A supported Devin CLI platform"],
    releases: [
      {
        version: "3000.15.14",
        integrity: "sha512-TMQUET4+DWnTYCKX+vxlP9BQnee2TG3z59UrrHC44cTEf7y1nB5ulRffA6QXFA8p/JY97tSHk+KLYFSNlq8PRw==",
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
