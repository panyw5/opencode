import type {
  CliAgentConfig,
  CliAgentDescriptor,
  CliAgentID,
  CliAgentInfo,
  CliAgentTest,
  DshHomeUpdate,
  DshPluginInventory,
} from "../preload/types"
import { getCliAgentConfig, setCliAgentConfig } from "./native"
import { getClaudeInfo, testClaudeConfig } from "./claude-status"
import { getCodexInfo, testCodexConfig } from "./codex-status"
import {
  getDshApiKey,
  getDshHomeConfig,
  getDshInfo,
  listDshPlugins,
  setDshHomeConfig,
  setDshPluginEnabled,
  testDshConfig,
} from "./dsh-status"
import { getGrokInfo, testGrokConfig } from "./grok-status"
import { getPiInfo, testPiConfig } from "./pi-status"
import { getClineInfo, testClineConfig } from "./cline-status"
import { getDroidInfo, testDroidConfig } from "./droid-status"
import { getQoderInfo, testQoderConfig } from "./qoder-status"
import { parseDshConsultDefaults } from "@opencode-ai/util/dsh-config"

type CliAgentDefinition = {
  descriptor: CliAgentDescriptor
  getInfo: (config?: CliAgentConfig) => Promise<CliAgentInfo>
  test: (config: CliAgentConfig) => Promise<CliAgentTest>
}

const cliAgents: Record<CliAgentID, CliAgentDefinition> = {
  pi: {
    descriptor: {
      id: "pi",
      label: "Pi",
      command: "pi",
      sourceUrl: "https://github.com/earendil-works/pi",
      configHomeLabel: "PI_CODING_AGENT_DIR",
      configHomePlaceholder: "~/.pi/agent",
    },
    getInfo: getPiInfo,
    test: testPiConfig,
  },
  codex: {
    descriptor: {
      id: "codex",
      label: "Codex",
      command: "codex",
      sourceUrl: "https://github.com/openai/codex",
      configHomeLabel: "CODEX_HOME",
      configHomePlaceholder: "~/.codex",
    },
    getInfo: getCodexInfo,
    test: testCodexConfig,
  },
  claude: {
    descriptor: {
      id: "claude",
      label: "Claude",
      command: "claude",
      sourceUrl: "https://docs.anthropic.com/en/docs/claude-code",
      configHomeLabel: "CLAUDE_CONFIG_DIR",
      configHomePlaceholder: "~/.claude",
    },
    getInfo: getClaudeInfo,
    test: testClaudeConfig,
  },
  grok: {
    descriptor: {
      id: "grok",
      label: "Grok Build",
      command: "grok",
      sourceUrl: "https://grok.com",
      configHomeLabel: "GROK_HOME",
      configHomePlaceholder: "~/.grok",
    },
    getInfo: getGrokInfo,
    test: testGrokConfig,
  },
  dsh: {
    descriptor: {
      id: "dsh",
      label: "DeepSeek",
      command: "dsh",
      sourceUrl: "https://github.com/deepseek-ai/deepseek-harness",
      configHomeLabel: "DSH_HOME",
      configHomePlaceholder: "~/.dsh",
    },
    getInfo: getDshInfo,
    test: testDshConfig,
  },
  cline: {
    descriptor: {
      id: "cline",
      label: "Cline",
      command: "cline",
      sourceUrl: "https://github.com/cline/cline",
      configHomeLabel: "CLINE_DIR",
      configHomePlaceholder: "~/.cline",
    },
    getInfo: getClineInfo,
    test: testClineConfig,
  },
  droid: {
    descriptor: {
      id: "droid",
      label: "Factory Droid",
      command: "droid",
      sourceUrl: "https://docs.factory.ai",
      configHomeLabel: "DROID_CONFIG_DIR",
      configHomePlaceholder: "~/.factory",
    },
    getInfo: getDroidInfo,
    test: testDroidConfig,
  },
  qoder: {
    descriptor: {
      id: "qoder",
      label: "Qoder",
      command: "qoder",
      sourceUrl: "https://qoder.com/cli",
      configHomeLabel: "QODER_CONFIG_DIR",
      configHomePlaceholder: "~/.qoder",
    },
    getInfo: getQoderInfo,
    test: testQoderConfig,
  },
}

export const cliAgentDescriptors = Object.freeze(Object.values(cliAgents).map((agent) => agent.descriptor))

export function getCliAgent(id: CliAgentID) {
  return getCliAgentConfig(id)
}

export function setCliAgent(id: CliAgentID, config: CliAgentConfig) {
  if (id === "dsh" && config.defaults !== undefined) {
    config = { ...config, defaults: parseDshConsultDefaults(config.defaults) }
  }
  setCliAgentConfig(id, config)
}

export function testCliAgent(id: CliAgentID, config: CliAgentConfig) {
  return cliAgents[id].test(config)
}

export function getCliAgentInfo(id: CliAgentID, config?: CliAgentConfig) {
  return cliAgents[id].getInfo(config)
}

export function getDshHome(config?: CliAgentConfig) {
  return getDshHomeConfig(config)
}

export function getDshStoredApiKey(config?: CliAgentConfig) {
  return getDshApiKey(config)
}

export function setDshHome(config: CliAgentConfig, update: DshHomeUpdate) {
  return setDshHomeConfig(config, update)
}

export function listDshPluginInventory(config?: CliAgentConfig, profile?: string): Promise<DshPluginInventory> {
  return listDshPlugins(config, profile)
}

export function setDshPluginEnabledState(
  config: CliAgentConfig | undefined,
  input: { profile?: string; id: string; enabled: boolean },
): Promise<DshPluginInventory> {
  return setDshPluginEnabled(config, input)
}
