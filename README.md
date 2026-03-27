# Claude Discord Bot

A Discord bot that gives you a full Claude Code experience through Discord. Send messages, get live status embeds, stream responses, manage context, and control everything with slash-style commands.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green) ![Discord.js](https://img.shields.io/badge/discord.js-v14-blue)

## What it does

- **Full Claude Code integration** — spawns Claude CLI processes, streams output as live Discord embeds
- **Thread-based conversations** — each message creates a thread with its own persistent session
- **Live status embeds** — see what Claude is doing in real-time (thinking, tool calls, progress)
- **Streaming text** — partial responses appear as Claude writes them
- **Context tracking** — monitor token usage per thread with visual progress bars
- **Plan usage monitoring** — check your Anthropic 5h session and 7d weekly limits
- **Rate limit gating** — asks for confirmation when plan limits are running low
- **Auto-compact** — automatically summarizes and resets when context gets too high
- **Queue system** — handles multiple concurrent requests with configurable limits
- **Configurable from Discord** — settings, models, working directories, all via commands

## Quick Start

### Prerequisites

- **Node.js 18+** — `node -v` to check
- **Claude CLI** — [Install Claude Code](https://docs.anthropic.com/en/docs/claude-code), then run `claude login`
- **A Discord bot** — [Create one here](https://discord.com/developers/applications)

### 1. Clone and run setup

```bash
git clone https://github.com/tckelly6397/mainframe.git
cd mainframe
./setup.sh
```

The setup script walks you through everything:
- Discord bot token and your user ID
- Channel configuration (optional)
- Systemd service installation (optional)

That's it. You're done.

### 2. Manual setup (if you prefer)

```bash
git clone https://github.com/tckelly6397/mainframe.git
cd mainframe
npm install
```

Create a `.env` file:

```env
DISCORD_TOKEN=your-bot-token-here
ALLOWED_USER_ID=your-discord-user-id

# Optional — shown in Claude's system prompt
BOT_OWNER=YourName
SERVER_NAME=my-server

# Optional — for organized channel layout (see below)
MAIN_CHANNEL_ID=
ADMIN_CHANNEL_ID=

# Optional — override paths
APPS_DIR=/home/you/apps
CLAUDE_PATH=/usr/local/bin/claude
BOT_HOME=/home/you
```

Start the bot:

```bash
node bot.js
```

## Discord Bot Setup

### Create the bot application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name
3. Go to **Bot** tab:
   - Click **Reset Token**, copy it — this is your `DISCORD_TOKEN`
   - Enable **Message Content Intent** (required)
4. Go to **OAuth2 > URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Embed Links, Attach Files, Add Reactions, Read Message History
5. Copy the generated URL, open it in your browser, and add the bot to your server

### Get your User ID

1. In Discord: Settings > Advanced > Enable **Developer Mode**
2. Right-click your username > **Copy User ID**
3. This is your `ALLOWED_USER_ID` — only you can use the bot

## Server Organization

### Recommended layout

Create a category and two channels for a clean setup:

```
📁 Claude Bot
  #claude          ← Main channel (MAIN_CHANNEL_ID)
  #claude-admin    ← Bot commands (ADMIN_CHANNEL_ID)
```

- **#claude** — where you talk to Claude. Messages create threads automatically.
- **#claude-admin** — for `/settings`, `/usage`, `/help`, and other admin commands. Claude won't spawn here.

Right-click each channel > **Copy Channel ID** to get the IDs for your `.env`.

### Without channel configuration

If you leave `MAIN_CHANNEL_ID` and `ADMIN_CHANNEL_ID` blank, the bot responds to:
- Direct messages
- @mentions in any channel
- Messages in existing threads

Commands (`/help`, `/usage`, etc.) work anywhere the bot can see them regardless of configuration.

## Commands

All commands work in any channel. Just type them as regular messages (not Discord slash commands).

### Thread Context *(per-thread, 1M token window)*

| Command | What it does |
|---------|-------------|
| `/context` | Shows how full this thread's context window is |
| `/compact` | Summarizes the conversation and starts a fresh session to free up context |

### Plan Usage *(account-level Anthropic limits)*

| Command | What it does |
|---------|-------------|
| `/usage` | Live 5h session and 7d weekly usage from Anthropic API |

### Session Control

| Command | What it does |
|---------|-------------|
| `/cancel` | Kill the running Claude process (or react 🛑 on the status embed) |
| `/model [opus\|sonnet\|haiku]` | View or change the model for this thread |
| `/app [name]` | List apps or switch working directory to an app |
| `/cwd [path]` | View or set the working directory manually |

### Configuration

| Command | What it does |
|---------|-------------|
| `/help` | Show all commands |
| `/settings` | View all configurable settings |
| `/set <key> <value>` | Change a setting |

### Configurable settings

Change any of these with `/set <key> <value>`:

| Setting | Default | Description |
|---------|---------|-------------|
| `max_concurrent` | 2 | Max Claude processes running at once |
| `idle_timeout` | 600 | Kill idle process after N seconds |
| `context_warn` | 0.80 | Warn when thread context exceeds this % |
| `auto_compact` | 0.90 | Auto-compact when thread context exceeds this % |
| `max_turns` | 50 | Max tool-use turns per request |
| `default_model` | opus | Default model for new threads |
| `streaming_text` | true | Show partial text while Claude works |
| `partial_flush_interval` | 3 | Seconds between streaming text updates |
| `auto_rename_threads` | true | Rename threads based on Claude's response |
| `heartbeat_channel` | *(empty)* | Channel ID for status heartbeat |

## Auto Behaviors

- **Context warning at 80%** — sends a warning embed when a thread's context is getting full
- **Auto-compact at 90%** — automatically compacts the session on the next message
- **Rate limit gate** — asks for confirmation when plan session < 20% or weekly < 10% remaining
- **Queue** — if max concurrency is reached, requests queue with position indicators
- **Thread naming** — new threads get renamed based on Claude's first response
- **Graceful shutdown** — on SIGTERM, waits for active processes to finish (30s timeout)

## Custom System Prompt

Create a `system-prompt.md` file in the bot directory to add custom context that Claude will always have. This is where you put infrastructure details, deployment patterns, or anything specific to your setup.

Example:

```markdown
## Infrastructure
This server runs Docker with Traefik reverse proxy.
Apps live in ~/apps/<appname>/ with docker-compose.yml files.

## Deployment
To deploy a new app, create the directory and docker-compose.yml.
Traefik auto-routes via container labels.
```

This file is `.gitignore`d so each deployment can have its own.

## Running as a Service

The setup script can install a systemd service for you. If you want to do it manually:

```bash
sudo cp claude-discord.service /etc/systemd/system/
# Edit the service file to match your user/paths
sudo systemctl daemon-reload
sudo systemctl enable claude-discord
sudo systemctl start claude-discord
```

Useful commands:
```bash
sudo systemctl status claude-discord     # Check status
sudo systemctl restart claude-discord    # Restart
journalctl -u claude-discord -f          # Live logs
```

## Multiple Bots on One Server

Each person needs:
1. Their own Discord bot application (separate token)
2. Their own Claude CLI login
3. Their own copy of this repo
4. A different systemd service name (the setup script asks)

The setup script handles all of this. Each bot gets its own channels, sessions, and settings — completely independent.

## File Structure

```
├── bot.js              # The bot (all logic in one file)
├── setup.sh            # Interactive setup script
├── package.json        # Dependencies
├── .env                # Your config (git-ignored)
├── system-prompt.md    # Custom Claude context (git-ignored)
├── sessions.json       # Thread sessions (git-ignored, auto-created)
├── settings.json       # Bot settings (git-ignored, auto-created)
├── usage-log.json      # Usage tracking (git-ignored, auto-created)
└── bot.log             # Structured logs (git-ignored, auto-created)
```

## Troubleshooting

**Bot doesn't respond to messages**
- Check that Message Content Intent is enabled in the Discord Developer Portal
- Verify `ALLOWED_USER_ID` matches your Discord user ID
- If using channel config, make sure `MAIN_CHANNEL_ID` is correct

**Claude process fails immediately**
- Run `claude --version` to verify Claude CLI is installed and authenticated
- Run `claude login` if needed
- Check logs: `journalctl -u claude-discord -f`

**"Another bot instance is running"**
- The bot uses a lock file to prevent duplicates
- If the previous instance crashed: `rm .bot.lock` then restart
