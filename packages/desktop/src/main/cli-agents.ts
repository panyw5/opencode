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

type CliAgentDefinition = {
  descriptor: CliAgentDescriptor
  getInfo: (config?: CliAgentConfig) => Promise<CliAgentInfo>
  test: (config: CliAgentConfig) => Promise<CliAgentTest>
}

const cliAgents: Record<CliAgentID, CliAgentDefinition> = {
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
      configHomeLabel: "Grok config home",
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
}

export const cliAgentDescriptors = Object.freeze(Object.values(cliAgents).map((agent) => agent.descriptor))

export function getCliAgent(id: CliAgentID) {
  return getCliAgentConfig(id)
}

export function setCliAgent(id: CliAgentID, config: CliAgentConfig) {
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
