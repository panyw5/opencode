import { DEFAULT_GPT_PRO_CONFIG, GPT_PRO_PARTITION, type GptProConfig, type GptProJob } from "@opencode-ai/util/gpt-pro"
import { browserController } from "./browser"
import { getStore } from "./store"
import { GptProController, type GptProPageResources } from "./gpt-pro-controller"
import { GptProDriver } from "./gpt-pro-driver"
import { write as writeLog } from "./logging"
import { app } from "electron"

let instance: GptProController | undefined
export function getGptProController() {
  if (instance) return instance
  const store = getStore("gpt-pro-consultations")
  const withExistingPage = async <T>(pageID: string, epoch: number, action: (driver: GptProDriver) => Promise<T>) => {
    const state = browserController.getState().find((view) => (view.pageID ?? view.partition) === pageID)
    if (!state || state.epoch !== epoch || state.kind !== "consultation")
      throw new Error("Consultation page changed before lifecycle operation")
    const driver = new GptProDriver(browserController, (message) => writeLog("gpt-pro", message), {
      pageID,
      profileID: state.profileID ?? GPT_PRO_PARTITION,
      owner: state.owner,
    })
    driver.recover()
    try {
      return await action(driver)
    } finally {
      driver.dispose()
    }
  }
  const resources: GptProPageResources = {
    list: () => browserController.listConsultationPages(),
    inspect: (pageID, epoch) => withExistingPage(pageID, epoch, (driver) => driver.page()),
    stop: (pageID, epoch) => withExistingPage(pageID, epoch, (driver) => driver.stop()),
    close: (pageID, epoch, reason) => browserController.closeIfEpoch(pageID, epoch, reason),
    setFocus: (pageID, epoch, enabled) => browserController.setPageFocusEmulation(pageID, epoch, enabled),
    onClosed: (listener) => browserController.onViewClosed((pageID, epoch, _profileID, reason) => listener(pageID, epoch, reason)),
    onProtectionChanged: (listener) => browserController.onProtectionChanged(listener),
  }
  instance = new GptProController(
    (job) =>
      new GptProDriver(browserController, (message) => writeLog("gpt-pro", message), {
        pageID: job.pageID ?? `gpt-pro-page-${job.id}`,
        profileID: job.profileID ?? GPT_PRO_PARTITION,
        owner: job.ownerPage,
      }),
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
    undefined,
    undefined,
    { resources },
  )
  app.once("before-quit", () => instance?.dispose())
  return instance
}
