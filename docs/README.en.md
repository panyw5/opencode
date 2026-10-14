# OpenCode Studio

> A customized desktop edition based on [OpenCode](https://github.com/anomalyco/opencode)

[简体中文](../README.md) | English

This is a personal fork of **OpenCode Desktop** with extensive UI improvements and feature enhancements. It preserves OpenCode's core capabilities while improving the desktop experience and day-to-day efficiency.

## ✨ Highlights

### OpenClaw, Hermes, and GenericAgent Integration

<p align="center">
  <img width="165" height="128" alt="image" src="https://github.com/user-attachments/assets/598d7347-39e0-4662-85da-84fc4263131e" />
  <img width="450" height="128" alt="image" src="https://github.com/NousResearch/hermes-agent/raw/main/assets/banner.png" />
</p>

<img src="../image/README/1786703087225.png" width="100%" />

<p align="center">
  <img src="../image/README/1786602375333.png" width="32%" />
  <img src="../image/README/1786602424940.png" width="32%" />
  <img src="../image/README/1786603270669.png" width="32%" />
</p>

#### Advanced agent capabilities

- **Math Mode**: integrates the [Danus](https://github.com/frenzymath/Danus) mathematical agent framework for efficiently tackling complex, long-horizon math tasks
- **Background shell commands and agents**: run shell commands and subagents in the background, with results automatically injected into the main agent's conversation when complete; supports asynchronous, graceful session stopping
- **Scheduled tasks**: agents can autonomously create, modify, and manage scheduled tasks
- **Project tasks**: a hierarchy of cross-session project tasks and session-level todos that agents can autonomously create, modify, and manage
- **Codex, Claude, Grok, and dsh advisors**: integrates external agents that the main agent can call for advice during a session
- **GPT Pro**: agents can autonomously consult the built-in ChatGPT web interface, making use of the user's web chat allowance
- **Built-in browser**: an integrated browser that agents can control autonomously
- **Messaging integrations**: chat with OpenCode through QQ, Feishu, and WeChat

#### Interaction improvements

- **Quick navigation**: a unified home dashboard and session tabs; `Cmd+T` to quickly switch projects and create sessions, and `Cmd+1...5` to switch sessions
- **Convenient notifications**: respond quickly through permission-request pills on session tabs, with all notifications collected in one place
- **Folder drag and drop**: drop a folder onto the window to open a project directly
- **Input autocompletion**: autocompletion across all prompt inputs and Markdown editors
- **Question tool improvements**:
  - keyboard support with `Cmd+Enter` to submit
  - collapsible and expandable question panel
  - image paste support
  - `Cmd+Enter` to confirm edits in custom answer fields
  - call history shows the options and the user's answer, with one-click copy
- **Session status panel**: view session file changes, status, and other details at any time
- **In-page and global search**: `Cmd+F` opens in-page search, and `Cmd+Shift+F` opens global search (requires indexing to be enabled)
- **File navigation**: click a file path to preview the file; `Cmd/Ctrl + click` opens it in an editor or file manager
- **Reading mode**: enter a focused reading mode with one click to remove distractions
- **All-in-one configuration panel**: configure providers, agents, skills, commands, plugins, and MCP servers in one place

<p align="center">
  <img src="../image/README/1777965458550.png" width="32%" />
  <img src="../image/README/1774018220930.png" width="32%" />
  <img src="../image/README/1774018327446.png" width="32%" />
  <img src="../image/README/1774018439717.png" width="32%" />
  <img src="../image/README/1770281479127.png" width="32%" />
</p>

### ⌨️ Added shortcuts

| Shortcut        | Action            | Description                                  |
| --------------- | ----------------- | -------------------------------------------- |
| `Cmd+T`         | Project switcher  | Quickly switch between multiple projects     |
| `Cmd+1...5`     | Quick session     | Jump to the 1st-5th session of the project    |
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
  - file preview supports "open in another app", copy path, and reveal in folder

## 📦 Installation

### Download a release

Download the latest OpenCode Desktop build from the [releases page](https://github.com/panyw5/opencode/releases).

#### Fixing the "app is damaged" error

If macOS shows an "app is damaged" warning when opening an older version of the app,

<p align="center">
  <img src="../image/README/1773199311694.png" width="32%" />
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

> **Note**: The desktop build automatically builds and packages the CLI sidecar. See the [build notes](../packages/desktop/AGENTS.md) for details.

### Development mode

```bash
# Start the development server
bun run dev:desktop
```

For the official version, visit:

- Official repository: https://github.com/anomalyco/opencode
- Official download: https://opencode.ai/download

---

# Community

[Linux.do](https://linux.do/t/topic/1802735)
