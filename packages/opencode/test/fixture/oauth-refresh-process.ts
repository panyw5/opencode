import { refreshOAuth } from "../../src/plugin/oauth-refresh"

const [endpoint, file] = process.argv.slice(2)
const value = await refreshOAuth("test", endpoint, "shared-process-credential", async () => {
  const latest = await Bun.file(file).json()
  if (latest.access === "fresh") return latest.access
  const response = await fetch(endpoint)
  const refreshed = await response.json()
  await Bun.write(file, JSON.stringify(refreshed))
  return refreshed.access
})
console.log(value)
