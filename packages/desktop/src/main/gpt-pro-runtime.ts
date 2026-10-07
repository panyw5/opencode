import { DEFAULT_GPT_PRO_CONFIG, type GptProConfig, type GptProJob } from "@opencode-ai/util/gpt-pro"
import { browserController } from "./browser"
import { getStore } from "./store"
import { GptProController } from "./gpt-pro-controller"
import { GptProDriver } from "./gpt-pro-driver"
import { write as writeLog } from "./logging"
import { app } from "electron"

let instance: GptProController | undefined
export function getGptProController() {
  if (instance) return instance
  const store = getStore("gpt-pro-consultations")
  instance = new GptProController(
    new GptProDriver(browserController, (message) => writeLog("gpt-pro", message)),
    {
      load: () => {
        const value = store.get("jobs")
        return Array.isArray(value)
          ? (value.filter(
              (job) =>
                job && typeof job.id === "string" && typeof job.owner === "string" && typeof job.prompt === "string",
            ) as GptProJob[])
          : []
      },
      save: (jobs) => store.set("jobs", jobs),
      config: () => (store.get("config") as GptProConfig | undefined) ?? DEFAULT_GPT_PRO_CONFIG,
      setConfig: (config) => store.set("config", config),
      stagingRoot: () => `${app.getPath("userData")}/gpt-pro/attachments`,
    },
    (message) => writeLog("gpt-pro", message),
  )
  app.once("before-quit", () => instance?.dispose())
  return instance
}
