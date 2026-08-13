# OpenCode Studio

> A customized desktop edition based on [OpenCode](https://github.com/anomalyco/opencode)

[简体中文](README.md) | English

This is a personal fork of **OpenCode Desktop** with significant UI polish and quality-of-life improvements. It keeps OpenCode's core capabilities intact while focusing on a better desktop interaction model and a more efficient day-to-day workflow. The `opencode` core itself is mostly unchanged due to the scope of this fork.

## ✨ Highlights

### Frontend architecture

- **Electron frontend**: the frontend has moved to Electron for smoother rendering and more fluid interactions (v1.15.10)

### OpenClaw Integration

<p align="center">
  <img width="165" height="128" alt="image" src="https://github.com/user-attachments/assets/598d7347-39e0-4662-85da-84fc4263131e" />
  <img width="450" height="128" alt="image" src="https://github.com/NousResearch/hermes-agent/raw/main/assets/banner.png" />
</p>

### 🎨 UI Improvements

<p align="center">
  <img src="image/README/1770281547328.png" width="32%" />
  <img src="image/README/1770281509446.png" width="32%" />
  <img src="image/README/1770281479127.png" width="32%" />
</p>

#### Enhanced theming

- **UI performance improvements**: noticeably faster rendering and better responsiveness
- **Full theme support**: loads every theme configuration provided by OpenCode CLI
- **New themes**: added `chatgpt` and `Arc` themes, with ongoing polish for light and dark variants (v1.3.5, v1.3.17)
- **Syntax highlighting**: AI code responses follow the active theme for a consistent visual experience
- **LaTeX highlighting**: copy rendered LaTeX code directly from the chat (v1.15.11)
- **Markdown rendering**: native Markdown parsing for user and agent messages, including LaTeX math rendering
- **Agent model metadata**: shows agent, channel, model, and related metadata inside agent messages

#### Interface customization

- **Adjustable conversation width**: choose narrow, medium, wide, extra wide, or full width layouts
- **Font size control**: tune text size dynamically for better readability
- **Reading mode**: one-click focused reading mode to remove distractions (v1.3.5)
- **Hooks visibility**: optionally show custom `hooks` calls directly in the conversation

#### Interaction improvements

- **Folder drag and drop**: drop a folder onto the window to open a project directly
- **Project icon reordering**: `Cmd + drag` to quickly reorder project icons (v1.3.5)
- **Basic input autocompletion**: automatic pairing and deletion for brackets, quotes, and similar characters
- **Fast project switcher**: added `Cmd+T` for quick switching between projects
- **Tabs**: multi-session tabs, with subagent sessions nested under their parent tab (v1.17.2, v1.18.20)
- **Assistant identity display**: shows assistant identity metadata in sessions
- **Question tool improvements**:
  - keyboard support with `Cmd+Enter` to submit
  - collapsible and expandable question panel
  - multiline input with `Enter` for complex prompts
  - image paste support
  - `Cmd+Enter` to confirm edits in custom answer fields
  - call history shows the options and the user's answer, with one-click copy (v1.17.0)
- **Thinking display**: shows the model's thinking, collapsed by default with a few-line preview while streaming (v1.3.19)
- **SKILL support**: automatically detects `skill` invocations and displays them as tools in the conversation flow
- **Session status panel**: view session file changes and status details, with copy support (v1.18.13)
- **Todo panel**: moved to the top-right of the session to save space (v1.17.2)
- **Background subagents**: run subagent calls in the background and show results in the conversation (v1.18.14)

- **Archive support**: archive sessions, delete archived sessions, or restore them later
- **Quick app launcher**: open the current workspace in VS Code, Zed, Finder, WezTerm, and other common apps
- **Hidden theme entry**: moves theme switching into a secondary command menu to reduce accidental changes
- **Find support**: `Cmd+F` opens the find dialog
- **Prompt editor**: added a dedicated editor for writing longer prompts, with bracket/quote autocompletion, `@` file references, and live Markdown preview (v1.15.10)
- **Markdown preview**: `.md`, `.py`, `.json`, and other common files can be previewed directly
- **File navigation**: click a file path to preview the file; `Cmd/Ctrl + click` opens it in an editor or file manager
- **Temporary attachments**: quickly attach temporary files to a conversation (v1.15.12)
- **Backend reload**: added a command to reload the backend, with a loading indicator (v1.15.13)

#### Task management

- **Built-in task system**: project-level task management (no Trellis dependency) with task lists, descriptions, `prd.md` preview, and task creation (v1.18.15)
- **Trellis support**: view task progress and `prd.md` (v1.3.17)

#### Scheduled tasks and external agents

- **Scheduled tasks**: run scheduled tasks and expose the scheduled task API to agents (v1.17.1, v1.18.20)
- **Feishu channel**: Feishu messaging integration (v1.17.1)
- **Codex advisor**: Codex integrated as an external agent, callable by the main agent as an external advisor (v1.17.1)

#### Configuration panel

The new configuration panel lets you edit the following directly in the GUI:

- global `AGENTS.md`
- model providers, including custom provider model types (with automatic model fetching and connection testing) (v1.15.11, v1.18.15)
- agent `.md` files
- global and project-level skill `SKILL.md` files
- plugins
- `OpenClaw`, `Hermes`, `GenericAgent`
- MCP servers and command configuration (v1.15.13)
- searchable configuration sections listing skills, plugins, and agents across all projects (v1.17.0, v1.13.20)

<p align="center">
  <img src="image/README/1774018220930.png" width="32%" />
  <img src="image/README/1774018327446.png" width="32%" />
  <img src="image/README/1774018439717.png" width="32%" />
</p>

### ⌨️ Added shortcuts

| Shortcut        | Action            | Description                                  |
| --------------- | ----------------- | -------------------------------------------- |
| `Cmd+T`         | Project switcher  | Quickly switch between multiple projects     |
| `Cmd+1...5`     | Quick session     | Jump to the 1st-5th session of the project (v1.15.12) |
| `Cmd+↑/↓`       | Jump user message | Move to the previous or next user message    |
| `Cmd+.`         | Focus input       | Move focus to the prompt input box           |
| `Cmd+Shift+;`   | Skills list       | Show the list of available skills in session |
| `Cmd+;`         | Model list        | Show available models                        |

### 🖥️ Terminal and editor integration

- **New terminal support**:
  - Ghostty integration
  - WezTerm integration
- **Editor support**:
  - VS Code, Cursor, Sublime Text, and Zed
  - custom editor path configuration
  - open the project in Finder or the system file manager
  - file preview supports "open in another app", copy path, and reveal in folder (v1.16.0, v1.15.12)

## 📦 Installation

### Download a release

Download the latest OpenCode Desktop build from the [releases page](https://github.com/panyw5/opencode/releases).

#### Fixing the "app is damaged" error

If macOS shows an "app is damaged" warning when opening the app,

<p align="center">
  <img src="image/README/1773199311694.png" width="32%" />
</p>

open `Terminal` and run:

```bash
cd /Applications
xattr -d com.apple.quarantine OpenCode.app
```

After that, launch `OpenCode` normally.

### Build from source

```bash
# Clone the repository
git clone https://github.com/panyw5/opencode.git
cd opencode

# Install dependencies
bun install

# Build the desktop app
bun run --cwd packages/desktop package:mac
```

### Quick macOS build script

```bash
# Build and open the output directory (macOS)
bun run --cwd packages/desktop package:mac && \
open packages/desktop/dist
```

> **Note**: The desktop build automatically builds and packages the CLI sidecar. See the [build notes](packages/desktop/AGENTS.md) for details.

### Development mode

```bash
# Start the development server
bun run dev:desktop
```

## 📖 About OpenCode

OpenCode is an open source AI coding agent with the following characteristics:

- 🔓 **100% open source**: a fully open codebase
- 🔌 **Model agnostic**: works with Claude, OpenAI, Google, and other models
- 🛠️ **LSP support**: language server support out of the box
- 💻 **Terminal first**: a powerful TUI built for terminal-oriented users
- 🏗️ **Client/server architecture**: flexible deployment and control patterns

### Built-in agents

- **build**: the default full-capability development agent
- **plan**: a read-only analysis agent suited to code exploration
- **general**: a sub-agent for complex searches and multi-step tasks

## 🔗 Links

- **Upstream project**: [anomalyco/opencode](https://github.com/anomalyco/opencode)
- **Official website**: [opencode.ai](https://opencode.ai)
- **Official docs**: [opencode.ai/docs](https://opencode.ai/docs)
- **Discord community**: [discord.gg/opencode](https://discord.gg/opencode)

## 📝 Version info

- **Based on**: OpenCode v1.18.21
- **Custom build**: v1.18.21-custom
- **Last synced**: 2026-08-13

## 🔄 Relationship to upstream

This fork actively tracks upstream OpenCode updates and regularly merges new features and fixes. The main differences are:

- **UI and UX enhancements**: more customization options and interaction polish
- **External agents**: OpenClaw, Hermes, GenericAgent, and Codex advisor integration
- **Tasks and scheduling**: built-in task system, scheduled tasks, and Feishu messaging channel
- **Terminal integration**: additional Ghostty and WezTerm support
- **Performance work**: rendering improvements for large files and diffs
- **Platform features**: extra macOS, Windows, and Linux-specific improvements

All core behaviors stay aligned with upstream, so moving back to the official build remains straightforward.

## ⚠️ Disclaimer

This project is a personal custom build based on OpenCode. It is **not** an official OpenCode product and is **not affiliated** with the OpenCode team.

For the official version, visit:

- Official repository: https://github.com/anomalyco/opencode
- Official download: https://opencode.ai/download

---

# Community

[Linux.do](https://linux.do/t/topic/1802735)
