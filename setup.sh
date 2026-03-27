#!/bin/bash
set -e

# ─── Claude Discord Bot Setup ───────────────────────────────────────
# Interactive installer: creates .env, installs deps, sets up systemd

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="claude-discord"

echo "==================================="
echo "  Claude Discord Bot Setup"
echo "==================================="
echo ""

# ─── Check prerequisites ────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed."
  echo "Install it: https://nodejs.org/ or: sudo apt install nodejs npm"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required. Found: $(node -v)"
  exit 1
fi

if ! command -v claude &>/dev/null; then
  echo "WARNING: Claude CLI not found in PATH."
  echo "Make sure it's installed: https://docs.anthropic.com/en/docs/claude-code"
  echo "You can set CLAUDE_PATH in .env if it's in a non-standard location."
  echo ""
fi

# ─── Check if .env already exists ────────────────────────────────────

if [ -f "$SCRIPT_DIR/.env" ]; then
  echo "An .env file already exists at: $SCRIPT_DIR/.env"
  read -p "Overwrite it? (y/N): " OVERWRITE
  if [[ ! "$OVERWRITE" =~ ^[Yy]$ ]]; then
    echo "Keeping existing .env. Skipping to dependency install..."
    SKIP_ENV=true
  fi
fi

# ─── Gather info ─────────────────────────────────────────────────────

if [ "$SKIP_ENV" != "true" ]; then
  echo ""
  echo "── Discord Bot Setup ──"
  echo "Create a bot at https://discord.com/developers/applications"
  echo "Enable: MESSAGE CONTENT intent, bot scope with Send Messages + Manage Threads"
  echo ""

  read -p "Discord Bot Token: " DISCORD_TOKEN
  if [ -z "$DISCORD_TOKEN" ]; then
    echo "ERROR: Token is required."
    exit 1
  fi

  echo ""
  echo "Your Discord user ID (enable Developer Mode in Discord settings,"
  echo "then right-click your name > Copy User ID)"
  read -p "Your Discord User ID: " ALLOWED_USER_ID
  if [ -z "$ALLOWED_USER_ID" ]; then
    echo "ERROR: User ID is required."
    exit 1
  fi

  read -p "Your name (shown in bot messages) [$(whoami)]: " BOT_OWNER
  BOT_OWNER=${BOT_OWNER:-$(whoami)}

  read -p "Server name (shown in system prompt) [server]: " SERVER_NAME
  SERVER_NAME=${SERVER_NAME:-server}

  echo ""
  echo "── Channel Setup (optional) ──"
  echo "For clean server organization, create a category with two channels:"
  echo "  #claude       — main channel where you talk to Claude (threads spawn here)"
  echo "  #claude-admin — bot commands (/settings, /usage, /help)"
  echo "Right-click each channel > Copy Channel ID"
  echo "(Leave blank to use mention-based activation instead)"
  echo ""

  read -p "Main Channel ID (for Claude interaction): " MAIN_CHANNEL_ID
  read -p "Admin Channel ID (for bot commands): " ADMIN_CHANNEL_ID

  echo ""
  echo "── Paths ──"
  DEFAULT_APPS="$HOME/apps"
  read -p "Apps directory [$DEFAULT_APPS]: " APPS_DIR
  APPS_DIR=${APPS_DIR:-$DEFAULT_APPS}

  # ─── Write .env ──────────────────────────────────────────────────────

  cat > "$SCRIPT_DIR/.env" <<EOF
DISCORD_TOKEN=$DISCORD_TOKEN
ALLOWED_USER_ID=$ALLOWED_USER_ID
BOT_OWNER=$BOT_OWNER
SERVER_NAME=$SERVER_NAME
APPS_DIR=$APPS_DIR
MAIN_CHANNEL_ID=$MAIN_CHANNEL_ID
ADMIN_CHANNEL_ID=$ADMIN_CHANNEL_ID
EOF

  echo ""
  echo ".env written to $SCRIPT_DIR/.env"
fi

# ─── Install dependencies ───────────────────────────────────────────

echo ""
echo "Installing Node.js dependencies..."
cd "$SCRIPT_DIR"
npm install --production
echo "Dependencies installed."

# ─── Claude CLI check ───────────────────────────────────────────────

echo ""
if command -v claude &>/dev/null; then
  echo "Claude CLI found at: $(which claude)"
else
  echo "Claude CLI not found. Install it and run: claude login"
  echo "Docs: https://docs.anthropic.com/en/docs/claude-code"
fi

# ─── Systemd service ────────────────────────────────────────────────

echo ""
echo "── Systemd Service ──"
read -p "Install systemd service? (Y/n): " INSTALL_SERVICE
INSTALL_SERVICE=${INSTALL_SERVICE:-Y}

if [[ "$INSTALL_SERVICE" =~ ^[Yy]$ ]]; then
  CURRENT_USER=$(whoami)
  CURRENT_GROUP=$(id -gn)
  NODE_PATH=$(which node)

  # Allow custom service name for multi-bot servers
  read -p "Service name [$SERVICE_NAME]: " CUSTOM_SERVICE_NAME
  SERVICE_NAME=${CUSTOM_SERVICE_NAME:-$SERVICE_NAME}

  SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

  cat > "/tmp/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Claude Discord Bot (${SERVICE_NAME})
After=network-online.target
Wants=network-online.target

[Service]
User=$CURRENT_USER
Group=$CURRENT_GROUP
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_PATH $SCRIPT_DIR/bot.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF

  echo ""
  echo "Service file generated. Installing requires sudo."
  sudo mv "/tmp/${SERVICE_NAME}.service" "$SERVICE_FILE"
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"

  echo ""
  echo "Service installed: $SERVICE_NAME"
  echo "  Start:   sudo systemctl start $SERVICE_NAME"
  echo "  Stop:    sudo systemctl stop $SERVICE_NAME"
  echo "  Logs:    journalctl -u $SERVICE_NAME -f"
  echo "  Status:  sudo systemctl status $SERVICE_NAME"

  read -p "Start the bot now? (Y/n): " START_NOW
  START_NOW=${START_NOW:-Y}
  if [[ "$START_NOW" =~ ^[Yy]$ ]]; then
    sudo systemctl restart "$SERVICE_NAME"
    echo "Bot started! Check logs: journalctl -u $SERVICE_NAME -f"
  fi
else
  echo "Skipped. Run manually: node $SCRIPT_DIR/bot.js"
fi

# ─── Custom system prompt ───────────────────────────────────────────

echo ""
if [ ! -f "$SCRIPT_DIR/system-prompt.md" ]; then
  echo "TIP: Create $SCRIPT_DIR/system-prompt.md to add custom context"
  echo "to Claude's system prompt (infrastructure details, deployment patterns, etc.)"
else
  echo "Custom system prompt found: $SCRIPT_DIR/system-prompt.md"
fi

# ─── Discord server organization tips ────────────────────────────────

echo ""
echo "==================================="
echo "  Setup Complete!"
echo "==================================="
echo ""
echo "Recommended Discord server layout:"
echo ""
echo "  Category: Claude Bots"
echo "    #claude          <- Main channel (set as MAIN_CHANNEL_ID)"
echo "    #claude-admin    <- Commands & settings (set as ADMIN_CHANNEL_ID)"
echo ""
echo "Bot permissions needed:"
echo "  - Send Messages"
echo "  - Send Messages in Threads"
echo "  - Create Public Threads"
echo "  - Manage Threads"
echo "  - Embed Links"
echo "  - Attach Files"
echo "  - Add Reactions"
echo "  - Read Message History"
echo ""
echo "Invite your bot:"
echo "  https://discord.com/developers/applications -> your app -> OAuth2 -> URL Generator"
echo "  Scopes: bot"
echo "  Permissions: see above"
echo ""
