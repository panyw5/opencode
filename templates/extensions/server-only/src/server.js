import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

export default {
  id: pkg.opencode.id,
  async activate(host) {
    return {
      rpc: {
        ping: async () => ({ version: host.version, message: "extension-starter-ok" }),
      },
    }
  },
}
