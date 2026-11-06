import { render } from "solid-js/web"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { PlatformProvider } from "../../../app/src/context/platform"
import { LanguageProvider } from "../../../app/src/context/language"
import { TestProviderModelButton } from "../../../app/src/components/test-provider-model-button"
import { ModelTooltip } from "../../../app/src/components/model-tooltip"
import { ServerRow } from "../../../app/src/components/server/server-row"
import { PromptContextItems } from "../../../app/src/components/prompt-input/context-items"
import { RailTooltip } from "../../../app/src/pages/layout/rail-tooltip"

// Mount real components without editing providers, sessions or the user's configuration.
export function mount() {
  const host = document.createElement("div")
  host.id = "tooltip-contrast-fixtures"
  document.body.append(host)
  const dispose = render(
    () => (
      <PlatformProvider
        value={{ platform: "web", openLink() {}, async restart() {}, back() {}, forward() {}, async notify() {} }}
      >
        <LanguageProvider locale="zh">
          <div
            style={{
              position: "fixed",
              inset: "120px 20px 20px",
              "z-index": 90,
              padding: "160px 32px 32px",
              background: "var(--background-base)",
              display: "flex",
              "align-items": "flex-start",
              gap: "24px",
              "flex-wrap": "wrap",
            }}
          >
            <div data-audit="connection">
              <TestProviderModelButton baseURL="http://127.0.0.1:8090/v1" apiKey="" modelId="tooltip-audit" />
            </div>
            <div data-audit="model">
              <Tooltip
                openDelay={0}
                value={
                  <ModelTooltip
                    model={{
                      id: "gpt-test",
                      name: "Test Model",
                      provider: { name: "Test" },
                      reasoning: true,
                      modalities: { input: ["text", "image"] },
                      limit: { context: 128000 },
                    }}
                  />
                }
              >
                <button>模型说明</button>
              </Tooltip>
            </div>
            <div data-audit="server" style={{ width: "140px" }}>
              <ServerRow
                conn={{ type: "http", http: { url: "http://127.0.0.1:4096" }, displayName: "测试服务器" }}
                status={{ healthy: false, version: "1.0.0", message: "连接失败，请检查服务器状态" }}
              />
            </div>
            <div data-audit="file">
              <PromptContextItems
                items={[{ type: "file", key: "audit", path: "D:/tooltip-audit/example.ts" }]}
                active={() => false}
                openComment={() => {}}
                remove={() => {}}
                t={(key) => key}
              />
            </div>
            <div data-audit="keybind">
              <TooltipKeybind title="打开测试" keybind="Ctrl+K" openDelay={0}>
                <button>快捷键</button>
              </TooltipKeybind>
            </div>
            <div data-audit="project">
              <RailTooltip
                placement="bottom"
                title={
                  <>
                    在 <span data-slot="rail-tooltip-mark">cool money</span> 下新建会话
                  </>
                }
                keybind="Ctrl+N"
              >
                <button>项目名称</button>
              </RailTooltip>
            </div>
          </div>
        </LanguageProvider>
      </PlatformProvider>
    ),
    host,
  )
  return () => {
    dispose()
    host.remove()
  }
}
