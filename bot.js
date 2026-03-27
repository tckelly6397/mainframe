const { Client, GatewayIntentBits, Partials, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const HOME_DIR = process.env.BOT_HOME || os.homedir();
const CLAUDE_PATH = process.env.CLAUDE_PATH || (() => {
  try { return execSync('which claude', { encoding: 'utf8' }).trim(); }
  catch { return path.join(HOME_DIR, '.local/bin/claude'); }
})();
const APPS_DIR = process.env.APPS_DIR || path.join(HOME_DIR, 'apps');
const BOT_OWNER = process.env.BOT_OWNER || 'the owner';
const SERVER_NAME = process.env.SERVER_NAME || 'server';
const MAIN_CHANNEL_ID = process.env.MAIN_CHANNEL_ID || '';
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID || '';
const MAX_MESSAGE_LENGTH = 2000;
const SESSION_FILE = path.join(__dirname, 'sessions.json');
const USAGE_LOG_FILE = path.join(__dirname, 'usage-log.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const LOG_FILE = path.join(__dirname, 'bot.log');
const LOCK_FILE = path.join(__dirname, '.bot.lock');
const TIMER_TICK = 5000; // Update elapsed time in embed every 5s
const VALID_MODELS = ['opus', 'sonnet', 'haiku'];

// ─── Settings (editable via /settings in Discord) ────────────────────

const SETTINGS_SCHEMA = {
  max_concurrent:      { type: 'int',    default: 2,      min: 1, max: 10,   desc: 'Max concurrent Claude processes' },
  idle_timeout:        { type: 'int',    default: 600,    min: 60, max: 3600, desc: 'Kill idle process after N seconds' },
  context_warn:        { type: 'float',  default: 0.80,   min: 0.5, max: 0.95, desc: 'Warn when thread context window exceeds this % (per-thread, not plan)' },
  auto_compact:        { type: 'float',  default: 0.90,   min: 0.6, max: 0.99, desc: 'Auto-compact thread when context window exceeds this % (per-thread, not plan)' },
  max_turns:           { type: 'int',    default: 50,     min: 1, max: 200,  desc: 'Max tool-use turns per request' },
  default_model:       { type: 'choice', default: 'opus', choices: VALID_MODELS, desc: 'Default model for new threads' },
  streaming_text:      { type: 'bool',   default: true,   desc: 'Show partial text while Claude works' },
  partial_flush_interval: { type: 'int', default: 3,      min: 1, max: 30,   desc: 'Seconds between streaming text updates' },
  auto_rename_threads: { type: 'bool',   default: true,   desc: 'Rename threads based on Claude response' },
  heartbeat_channel:   { type: 'string', default: '',     desc: 'Channel ID for heartbeat (empty = disabled)' },
};

let settings = {};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {}
  // Fill in defaults for any missing keys
  for (const [key, schema] of Object.entries(SETTINGS_SCHEMA)) {
    if (settings[key] === undefined) settings[key] = schema.default;
  }
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

loadSettings();

// Accessor for settings (use these instead of constants)
function S(key) { return settings[key] ?? SETTINGS_SCHEMA[key]?.default; }

// Colors
const COLOR_STARTING = 0x5865F2; // Discord blurple
const COLOR_THINKING = 0x9B59B6; // Purple
const COLOR_WORKING  = 0xF59E0B; // Amber
const COLOR_SUCCESS  = 0x22C55E; // Green
const COLOR_ERROR    = 0xEF4444; // Red
const COLOR_INFO     = 0x3B82F6; // Blue

// Tool icons — minimal, only where it aids scanning
const TOOL_ICONS = {
  Read: '›', Write: '›', Edit: '›', Bash: '$',
  Glob: '›', Grep: '›', Agent: '›', WebFetch: '›',
  WebSearch: '›', Skill: '›', TaskCreate: '›', TaskUpdate: '›',
  NotebookEdit: '›', ToolSearch: '›', default: '›',
};

// ─── Structured logging ──────────────────────────────────────────────

function log(level, msg, meta = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  try { fs.appendFileSync(LOG_FILE, entry + '\n'); } catch (e) {}
  if (level === 'error') console.error(entry);
  else console.log(entry);
}

// ─── Prevent duplicate bot instances ─────────────────────────────────

let shuttingDown = false;

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      try {
        process.kill(oldPid, 0);
        log('error', `Another bot instance is running (PID ${oldPid}). Exiting.`);
        process.exit(1);
      } catch (e) {
        log('info', `Removing stale lock file (PID ${oldPid} is dead)`);
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch (e) {} });
  } catch (e) {
    log('error', 'Failed to acquire lock', { error: e.message });
  }
}
acquireLock();

// ─── Graceful shutdown ───────────────────────────────────────────────

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `${signal} received, draining ${activeProcesses.size} active processes...`);

  if (activeProcesses.size === 0) {
    process.exit(0);
  }

  const deadline = Date.now() + 30000;
  const check = setInterval(() => {
    if (activeProcesses.size === 0 || Date.now() > deadline) {
      clearInterval(check);
      if (activeProcesses.size > 0) {
        log('info', `Timeout: killing ${activeProcesses.size} remaining processes`);
        for (const [, entry] of activeProcesses) {
          try { entry.proc.kill('SIGKILL'); } catch (e) {}
        }
      }
      process.exit(0);
    }
  }, 500);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Session persistence ─────────────────────────────────────────────
// { threadId: { sessionId, usage, cwd, model, needsAutoCompact } }

let sessions = {};
try {
  if (fs.existsSync(SESSION_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') {
        sessions[k] = { sessionId: v, usage: null };
      } else {
        sessions[k] = v;
      }
    }
  }
} catch (e) {
  log('error', 'Failed to load sessions', { error: e.message });
}

function saveSessions() {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
}

// ─── Usage log ───────────────────────────────────────────────────────

let usageLog = [];
try {
  if (fs.existsSync(USAGE_LOG_FILE)) {
    usageLog = JSON.parse(fs.readFileSync(USAGE_LOG_FILE, 'utf8'));
  }
} catch (e) {
  log('error', 'Failed to load usage log', { error: e.message });
}

let lastRateLimit = null;

function saveUsageLog() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  usageLog = usageLog.filter(e => e.timestamp > cutoff);
  fs.writeFileSync(USAGE_LOG_FILE, JSON.stringify(usageLog, null, 2));
}

function logUsage(entry) {
  usageLog.push({ timestamp: Date.now(), ...entry });
  saveUsageLog();
}

function getUsageInWindow(windowMs) {
  const cutoff = Date.now() - windowMs;
  const entries = usageLog.filter(e => e.timestamp > cutoff);
  const totals = { requests: entries.length, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 };
  for (const e of entries) {
    totals.inputTokens += e.inputTokens || 0;
    totals.outputTokens += e.outputTokens || 0;
    totals.cacheRead += e.cacheRead || 0;
    totals.cacheCreate += e.cacheCreate || 0;
  }
  return totals;
}

// ─── Active processes & queue ────────────────────────────────────────

const activeProcesses = new Map(); // threadId -> { proc, channel, startTime }
const taskQueue = []; // { resolve, reject, prompt, sessionId, channel, options }

function dequeueNext() {
  if (taskQueue.length === 0 || activeProcesses.size >= S('max_concurrent')) return;
  const task = taskQueue.shift();
  // Update queue position embeds for remaining tasks
  for (let i = 0; i < taskQueue.length; i++) {
    const t = taskQueue[i];
    if (t.queueMsg) {
      t.queueMsg.edit({
        embeds: [new EmbedBuilder().setColor(COLOR_INFO).setTitle(`Queued — position ${i + 1}`)]
      }).catch(() => {});
    }
  }
  runClaudeStreaming(task.prompt, task.sessionId, task.channel, task.options)
    .then(task.resolve)
    .catch(task.reject);
}

async function enqueueOrRun(prompt, sessionId, channel, options = {}) {
  if (activeProcesses.size < S('max_concurrent')) {
    return runClaudeStreaming(prompt, sessionId, channel, options);
  }
  return new Promise((resolve, reject) => {
    const position = taskQueue.length + 1;
    const entry = { resolve, reject, prompt, sessionId, channel, options, queueMsg: null };
    taskQueue.push(entry);
    channel.send({
      embeds: [new EmbedBuilder()
        .setColor(COLOR_INFO)
        .setTitle(`Queued — position ${position}`)
        .setDescription(`${activeProcesses.size} processes running. Your request will start when a slot opens.`)]
    }).then(msg => { entry.queueMsg = msg; }).catch(() => {});
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

function getSessionId(threadId) {
  return sessions[threadId]?.sessionId || null;
}

function getSessionUsage(threadId) {
  return sessions[threadId]?.usage || null;
}

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function contextBar(percent) {
  const filled = Math.round(percent * 20);
  const empty = 20 - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  let tag = '';
  if (percent >= 0.9) tag = ' \u26a0\ufe0f CRITICAL';
  else if (percent >= 0.8) tag = ' \u26a0\ufe0f HIGH';
  return `\`${bar}\` ${(percent * 100).toFixed(1)}%${tag}`;
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

// ─── Rate limit probe ────────────────────────────────────────────────

function probeRateLimit() {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_PATH, [
      '-p', 'say ok', '--output-format', 'stream-json', '--verbose',
      '--max-turns', '1', '--dangerously-skip-permissions',
    ], {
      cwd: HOME_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: HOME_DIR,
        PATH: `${path.join(HOME_DIR, '.local/bin')}:${process.env.PATH}`,
        ANTHROPIC_LOG: 'debug',
      },
    });
    proc.stdin.end();

    const result = {
      rateLimit: null, model: null, contextWindow: null,
      fiveHour: null, sevenDay: null, overageStatus: null,
    };

    let stdoutBuf = '';
    proc.stdout.on('data', (data) => { stdoutBuf += data.toString(); });

    proc.stdout.on('end', () => {
      const h5util = stdoutBuf.match(/"anthropic-ratelimit-unified-5h-utilization":\s*"([^"]+)"/);
      const h5reset = stdoutBuf.match(/"anthropic-ratelimit-unified-5h-reset":\s*"([^"]+)"/);
      const h5status = stdoutBuf.match(/"anthropic-ratelimit-unified-5h-status":\s*"([^"]+)"/);
      const h7util = stdoutBuf.match(/"anthropic-ratelimit-unified-7d-utilization":\s*"([^"]+)"/);
      const h7reset = stdoutBuf.match(/"anthropic-ratelimit-unified-7d-reset":\s*"([^"]+)"/);
      const h7status = stdoutBuf.match(/"anthropic-ratelimit-unified-7d-status":\s*"([^"]+)"/);
      const hOverage = stdoutBuf.match(/"anthropic-ratelimit-unified-overage-status":\s*"([^"]+)"/);

      if (h5util) {
        result.fiveHour = {
          utilization: parseFloat(h5util[1]),
          resetsAt: h5reset ? parseInt(h5reset[1]) : null,
          status: h5status ? h5status[1] : 'unknown',
        };
      }
      if (h7util) {
        result.sevenDay = {
          utilization: parseFloat(h7util[1]),
          resetsAt: h7reset ? parseInt(h7reset[1]) : null,
          status: h7status ? h7status[1] : 'unknown',
        };
      }
      if (hOverage) result.overageStatus = hOverage[1];

      for (const line of stdoutBuf.split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'rate_limit_event' && event.rate_limit_info) {
            result.rateLimit = event.rate_limit_info;
            lastRateLimit = event.rate_limit_info;
          }
          if (event.type === 'result' && event.modelUsage) {
            const modelKey = Object.keys(event.modelUsage)[0];
            if (modelKey) {
              result.model = modelKey;
              result.contextWindow = event.modelUsage[modelKey].contextWindow;
            }
          }
        } catch (e) {}
      }
    });

    proc.on('close', () => resolve(result));
    proc.on('error', () => resolve(result));
    setTimeout(() => { try { proc.kill(); } catch(e) {} resolve(result); }, 15000);
  });
}

let cachedProbeResult = null;
let cachedProbeTime = 0;
const PROBE_CACHE_TTL = 2 * 60 * 1000;

async function getCachedProbe() {
  if (cachedProbeResult && (Date.now() - cachedProbeTime) < PROBE_CACHE_TTL) {
    return cachedProbeResult;
  }
  cachedProbeResult = await probeRateLimit();
  cachedProbeTime = Date.now();
  return cachedProbeResult;
}

// ─── Compact helper (shared by /compact and auto-compact) ────────────

async function compactSession(threadId, channel) {
  const sessionId = getSessionId(threadId);
  if (!sessionId) throw new Error('No session to compact');
  const oldUsage = getSessionUsage(threadId);
  const sessionCwd = sessions[threadId]?.cwd;
  const sessionModel = sessions[threadId]?.model;

  // Ask current session to summarize
  const { finalText: summary } = await runClaudeStreaming(
    'Produce a concise summary of everything we have discussed and done in this conversation so far. Include: key decisions, files created/modified, current project state, and any open questions. Keep it under 1500 characters. Output ONLY the summary, no preamble.',
    sessionId, channel, { threadId: threadId + '_compact_summary', cwd: sessionCwd, model: sessionModel }
  );

  // Start fresh session with summary
  const compactPrompt = `[CONTEXT RESTORED FROM PREVIOUS SESSION]\n${summary}\n\n[END CONTEXT]\n\nSession has been compacted. Previous context is summarized above. Ready to continue — say "ready" to confirm.`;
  const { sessionId: newSessionId, usage: newUsage } = await runClaudeStreaming(
    compactPrompt, null, channel, { threadId: threadId + '_compact_fresh', cwd: sessionCwd, model: sessionModel }
  );

  if (newSessionId) {
    sessions[threadId] = { sessionId: newSessionId, usage: newUsage, cwd: sessionCwd, model: sessionModel };
    saveSessions();
  }

  const oldPct = oldUsage?.percent ? `${(oldUsage.percent * 100).toFixed(1)}%` : 'unknown';
  const newPct = newUsage?.percent ? `${(newUsage.percent * 100).toFixed(1)}%` : 'unknown';
  return { oldPct, newPct };
}

// ─── Discord client ──────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

client.once('ready', () => {
  log('info', `Logged in as ${client.user.tag}`);

  // ─── Heartbeat ───
  if (S('heartbeat_channel')) {
    let heartbeatMessage = null;
    setInterval(async () => {
      try {
        const ch = await client.channels.fetch(S('heartbeat_channel'));
        const embed = new EmbedBuilder()
          .setColor(COLOR_SUCCESS)
          .setTitle('Bot Heartbeat')
          .addFields(
            { name: 'Uptime', value: formatElapsed(process.uptime() * 1000), inline: true },
            { name: 'Memory', value: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`, inline: true },
            { name: 'Active', value: `${activeProcesses.size} process(es)`, inline: true },
            { name: 'Queue', value: `${taskQueue.length} waiting`, inline: true },
            { name: 'Sessions', value: `${Object.keys(sessions).length} tracked`, inline: true },
          )
          .setTimestamp();
        if (heartbeatMessage) {
          await heartbeatMessage.edit({ embeds: [embed] });
        } else {
          heartbeatMessage = await ch.send({ embeds: [embed] });
        }
      } catch (e) {
        log('error', 'Heartbeat failed', { error: e.message });
      }
    }, 5 * 60 * 1000);
  }
});

// ─── Reaction-based cancel ───────────────────────────────────────────

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (user.id !== ALLOWED_USER_ID) return;
  if (reaction.emoji.name !== '\ud83d\uded1') return;

  const channelId = reaction.message.channel.id;
  const entry = activeProcesses.get(channelId);
  if (entry) {
    entry.proc.kill('SIGTERM');
    try {
      await reaction.message.channel.send({
        embeds: [new EmbedBuilder().setColor(COLOR_INFO).setTitle('Cancelled via reaction')]
      });
    } catch (e) {}
  }
});

// ─── Main message handler ────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (shuttingDown) {
    await message.reply('Bot is shutting down, not accepting new requests.');
    return;
  }

  if (message.author.id !== ALLOWED_USER_ID) {
    log('info', `Ignored message from unauthorized user: ${message.author.tag}`);
    return;
  }

  const isDM = !message.guild;
  const isMentioned = message.mentions.has(client.user);
  const isThread = message.channel.isThread();
  const channelId = message.channel.id;
  const parentChannelId = message.channel.parentId || null;

  // Channel routing
  const isMainChannel = MAIN_CHANNEL_ID && channelId === MAIN_CHANNEL_ID;
  const isAdminChannel = ADMIN_CHANNEL_ID && channelId === ADMIN_CHANNEL_ID;
  const isMainThread = isThread && parentChannelId === MAIN_CHANNEL_ID;

  let prompt = message.content;
  if (isMentioned) {
    prompt = prompt.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  }

  // ─── Bot commands — work anywhere the bot can see the message ─────
  const cmdMatch = prompt.match(/^\/(context|compact|usage|cancel|cwd|model|app|settings|set|help)(?:\s+(.*))?$/i);
  if (cmdMatch) {
    const cmd = cmdMatch[1].toLowerCase();
    const cmdArg = cmdMatch[2]?.trim() || null;
    const threadId = isThread ? message.channel.id : null;

    // ─── /help ───
    if (cmd === 'help') {
      const helpText = [
        '**Thread Context** *(per-thread 1M token window)*',
        '`/context` — How full this thread\'s context window is',
        '`/compact` — Summarize & reset to free up thread context',
        '',
        '**Plan Usage** *(5h session + 7d weekly limits)*',
        '`/usage` — Live rate limit % from Anthropic API',
        '> Asks for confirmation when plan limits run low',
        '',
        '**Session Control**',
        '`/cancel` — Kill running Claude process (or react \ud83d\uded1)',
        '`/model [sonnet|opus|haiku]` — View/set model for this thread',
        '`/app [name]` — List apps or switch working directory',
        '`/cwd [path]` — View/set working directory manually',
        '',
        '**Configuration**',
        '`/settings` — View all settings',
        '`/set <key> <value>` — Change a setting',
        '',
        '**Auto behaviors**',
        'Warns at **80%** thread context, auto-compacts at **90%**',
        'Asks before running when plan session <20% or weekly <10%',
        'Queues requests when at max concurrency',
        '*(all configurable via /settings)*',
      ].join('\n');
      await message.reply({
        embeds: [new EmbedBuilder().setColor(COLOR_INFO).setTitle('Commands').setDescription(helpText)]
      });
      return;
    }

    // ─── /context ───
    if (cmd === 'context') {
      const usage = threadId ? getSessionUsage(threadId) : null;
      if (!usage) {
        await message.reply('No context data for this thread yet. Start a conversation first.');
        return;
      }
      const totalInput = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheCreate || 0);
      const embed = new EmbedBuilder()
        .setColor(usage.percent >= S('context_warn') ? COLOR_ERROR : COLOR_INFO)
        .setTitle('Context Usage')
        .addFields(
          { name: 'Usage', value: contextBar(usage.percent || 0), inline: false },
          { name: 'Tokens', value: [
            `Input: **${formatTokens(usage.input || 0)}**`,
            `Output: **${formatTokens(usage.output || 0)}**`,
            `Cache read: **${formatTokens(usage.cacheRead || 0)}**`,
            `Cache create: **${formatTokens(usage.cacheCreate || 0)}**`,
            `Total effective: **${formatTokens(totalInput + (usage.output || 0))}**`,
          ].join('\n'), inline: true },
          { name: 'Window', value: [
            `Context window: **${formatTokens(usage.contextWindow || 0)}**`,
            `Remaining: ~**${formatTokens(Math.max(0, (usage.contextWindow || 0) - totalInput - (usage.output || 0)))}**`,
          ].join('\n'), inline: true }
        )
        .setFooter({ text: usage.percent >= S('context_warn') ? 'Consider running /compact to free up context' : 'Context looks healthy' })
        .setTimestamp();
      await message.reply({ embeds: [embed] });
      return;
    }

    // ─── /usage ───
    if (cmd === 'usage') {
      const loadingMsg = await message.reply({
        embeds: [new EmbedBuilder().setColor(COLOR_STARTING).setTitle('Checking plan usage...')]
      });

      cachedProbeResult = null; // Force fresh
      const probeInfo = await getCachedProbe();

      let sessionText = 'Could not reach API';
      let embedColor = COLOR_INFO;
      if (probeInfo.fiveHour) {
        const fh = probeInfo.fiveHour;
        sessionText = contextBar(fh.utilization);
        if (fh.resetsAt) {
          const remaining = Math.max(0, fh.resetsAt * 1000 - Date.now());
          const hrs = Math.floor(remaining / 3600000);
          const mins = Math.ceil((remaining % 3600000) / 60000);
          const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
          sessionText += `\nResets in **${timeStr}** (<t:${fh.resetsAt}:R>)`;
        }
        if (fh.utilization >= 0.9) embedColor = COLOR_ERROR;
        else if (fh.utilization >= 0.7) embedColor = COLOR_WORKING;
        if (fh.status === 'rejected') embedColor = COLOR_ERROR;
      }

      let weeklyText = 'No data';
      if (probeInfo.sevenDay) {
        const sd = probeInfo.sevenDay;
        weeklyText = contextBar(sd.utilization);
        if (sd.resetsAt) {
          const resetDate = new Date(sd.resetsAt * 1000);
          const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          const dayStr = dayNames[resetDate.getDay()];
          const timeStr = resetDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
          weeklyText += `\nResets **${dayStr} ${timeStr}** (<t:${sd.resetsAt}:R>)`;
        }
      }

      let modelText = '';
      if (probeInfo.model) {
        modelText = `**${probeInfo.model.replace('[1m]', ' (1M ctx)')}**`;
      }
      if (probeInfo.overageStatus) {
        modelText += `\nOverage: **${probeInfo.overageStatus}**`;
      }

      const fiveH = getUsageInWindow(5 * 60 * 60 * 1000);
      const twentyFourH = getUsageInWindow(24 * 60 * 60 * 1000);
      const totalFiveH = fiveH.inputTokens + fiveH.outputTokens + fiveH.cacheRead + fiveH.cacheCreate;
      const total24H = twentyFourH.inputTokens + twentyFourH.outputTokens + twentyFourH.cacheRead + twentyFourH.cacheCreate;

      const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setTitle('Plan Usage')
        .addFields(
          { name: 'Session Limit (5h)', value: sessionText, inline: false },
          { name: 'Weekly Limit (7d)', value: weeklyText, inline: false },
        );
      if (modelText) embed.addFields({ name: 'Plan', value: modelText, inline: true });
      embed.addFields(
        { name: 'Bot Stats (5h)', value: `**${fiveH.requests}** requests · **${formatTokens(totalFiveH)}** tokens`, inline: true },
        { name: 'Bot Stats (24h)', value: `**${twentyFourH.requests}** requests · **${formatTokens(total24H)}** tokens`, inline: true },
      )
      .setFooter({ text: `${Object.keys(sessions).length} sessions · ${activeProcesses.size} active · ${taskQueue.length} queued` })
      .setTimestamp();
      await loadingMsg.edit({ embeds: [embed] });
      return;
    }

    // ─── /compact ───
    if (cmd === 'compact') {
      if (!threadId || !getSessionId(threadId)) {
        await message.reply('No session to compact in this thread.');
        return;
      }
      const statusMsg = await message.reply({
        embeds: [new EmbedBuilder().setColor(COLOR_STARTING).setTitle('Compacting session...').setDescription('Asking Claude to summarize, then starting a fresh session.')]
      });
      try {
        const { oldPct, newPct } = await compactSession(threadId, message.channel);
        await statusMsg.edit({
          embeds: [new EmbedBuilder().setColor(COLOR_SUCCESS).setTitle('Session compacted')
            .setDescription(`Context: **${oldPct}** \u2192 **${newPct}**\nNew session is ready.`).setTimestamp()]
        });
      } catch (err) {
        await statusMsg.edit({
          embeds: [new EmbedBuilder().setColor(COLOR_ERROR).setTitle('Compact failed').setDescription(err.message.substring(0, 4000))]
        });
      }
      return;
    }

    // ─── /cancel ───
    if (cmd === 'cancel') {
      const entry = threadId ? activeProcesses.get(threadId) : null;
      if (entry) {
        entry.proc.kill('SIGTERM');
        await message.reply({ embeds: [new EmbedBuilder().setColor(COLOR_INFO).setTitle('Process cancelled')] });
      } else {
        await message.reply('No active process in this thread.');
      }
      return;
    }

    // ─── /cwd ───
    if (cmd === 'cwd') {
      if (!threadId) {
        await message.reply('Use /cwd inside a thread.');
        return;
      }
      if (!cmdArg) {
        const current = sessions[threadId]?.cwd || HOME_DIR;
        await message.reply(`Current working directory: \`${current}\``);
        return;
      }
      const targetPath = cmdArg;
      if (!fs.existsSync(targetPath)) {
        await message.reply(`Path does not exist: \`${targetPath}\``);
        return;
      }
      if (!sessions[threadId]) sessions[threadId] = { sessionId: null, usage: null };
      sessions[threadId].cwd = targetPath;
      saveSessions();
      await message.reply({ embeds: [new EmbedBuilder().setColor(COLOR_SUCCESS).setTitle('Working directory set').setDescription(`\`${targetPath}\``)] });
      return;
    }

    // ─── /model ───
    if (cmd === 'model') {
      if (!threadId) {
        await message.reply('Use /model inside a thread.');
        return;
      }
      if (!cmdArg) {
        const current = sessions[threadId]?.model || `${S('default_model')} (default)`;
        await message.reply(`Current model: **${current}**`);
        return;
      }
      const model = cmdArg.toLowerCase();
      if (!VALID_MODELS.includes(model)) {
        await message.reply(`Invalid model. Choose: ${VALID_MODELS.join(', ')}`);
        return;
      }
      if (!sessions[threadId]) sessions[threadId] = { sessionId: null, usage: null };
      sessions[threadId].model = model;
      saveSessions();
      await message.reply({ embeds: [new EmbedBuilder().setColor(COLOR_SUCCESS).setTitle('Model set').setDescription(`**${model}**`)] });
      return;
    }

    // ─── /app ───
    if (cmd === 'app') {
      const appsDir = APPS_DIR;
      if (!cmdArg) {
        // List available apps
        try {
          const entries = fs.readdirSync(appsDir, { withFileTypes: true });
          const apps = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
          if (apps.length === 0) {
            await message.reply(`No apps found in \`${APPS_DIR}\`.`);
            return;
          }
          const current = threadId && sessions[threadId]?.cwd;
          const currentApp = current ? path.basename(current) : null;
          const list = apps.map(a => `${a === currentApp ? '**\u25b6 ' + a + '**' : a}`).join('\n');
          await message.reply({
            embeds: [new EmbedBuilder().setColor(COLOR_INFO).setTitle('Apps').setDescription(list)
              .setFooter({ text: 'Use /app <name> to switch' })]
          });
        } catch (e) {
          await message.reply(`Failed to list apps: ${e.message}`);
        }
        return;
      }
      // Set cwd to app directory
      const appPath = path.join(appsDir, cmdArg);
      if (!fs.existsSync(appPath)) {
        // Fuzzy match: check if any app starts with the arg
        try {
          const entries = fs.readdirSync(appsDir, { withFileTypes: true });
          const match = entries.find(e => e.isDirectory() && e.name.toLowerCase().startsWith(cmdArg.toLowerCase()));
          if (match) {
            const matchPath = path.join(appsDir, match.name);
            if (!threadId) {
              await message.reply('Use /app inside a thread.');
              return;
            }
            if (!sessions[threadId]) sessions[threadId] = { sessionId: null, usage: null };
            sessions[threadId].cwd = matchPath;
            saveSessions();
            await message.reply({ embeds: [new EmbedBuilder().setColor(COLOR_SUCCESS).setTitle(`App: ${match.name}`).setDescription(`\`${matchPath}\``)] });
            return;
          }
        } catch (e) {}
        await message.reply(`App not found: \`${cmdArg}\`\nUse \`/app\` to list available apps.`);
        return;
      }
      if (!threadId) {
        await message.reply('Use /app inside a thread.');
        return;
      }
      if (!sessions[threadId]) sessions[threadId] = { sessionId: null, usage: null };
      sessions[threadId].cwd = appPath;
      saveSessions();
      await message.reply({ embeds: [new EmbedBuilder().setColor(COLOR_SUCCESS).setTitle(`App: ${cmdArg}`).setDescription(`\`${appPath}\``)] });
      return;
    }

    // ─── /settings or /set ───
    if (cmd === 'settings' || cmd === 'set') {
      if (!cmdArg) {
        // Show all settings
        const lines = [];
        for (const [key, schema] of Object.entries(SETTINGS_SCHEMA)) {
          const val = S(key);
          const display = typeof val === 'boolean' ? (val ? 'on' : 'off') : String(val);
          lines.push(`\`${key}\` = **${display}**\n> ${schema.desc}`);
        }
        await message.reply({
          embeds: [new EmbedBuilder().setColor(COLOR_INFO).setTitle('Settings')
            .setDescription(lines.join('\n'))
            .setFooter({ text: '/set <key> <value> to change' })]
        });
        return;
      }

      // Parse: /set key value
      const parts = cmdArg.split(/\s+/);
      const key = parts[0].toLowerCase();
      const rawValue = parts.slice(1).join(' ');

      if (!SETTINGS_SCHEMA[key]) {
        await message.reply(`Unknown setting: \`${key}\`\nUse \`/settings\` to list all.`);
        return;
      }

      if (!rawValue) {
        const val = S(key);
        const display = typeof val === 'boolean' ? (val ? 'on' : 'off') : String(val);
        await message.reply(`\`${key}\` = **${display}**\n> ${SETTINGS_SCHEMA[key].desc}`);
        return;
      }

      const schema = SETTINGS_SCHEMA[key];
      let parsed;

      if (schema.type === 'int') {
        parsed = parseInt(rawValue, 10);
        if (isNaN(parsed)) { await message.reply(`\`${key}\` must be a number.`); return; }
        if (schema.min !== undefined && parsed < schema.min) { await message.reply(`\`${key}\` minimum is ${schema.min}.`); return; }
        if (schema.max !== undefined && parsed > schema.max) { await message.reply(`\`${key}\` maximum is ${schema.max}.`); return; }
      } else if (schema.type === 'float') {
        parsed = parseFloat(rawValue);
        if (isNaN(parsed)) { await message.reply(`\`${key}\` must be a number.`); return; }
        if (schema.min !== undefined && parsed < schema.min) { await message.reply(`\`${key}\` minimum is ${schema.min}.`); return; }
        if (schema.max !== undefined && parsed > schema.max) { await message.reply(`\`${key}\` maximum is ${schema.max}.`); return; }
      } else if (schema.type === 'bool') {
        const lower = rawValue.toLowerCase();
        if (['true', 'on', 'yes', '1'].includes(lower)) parsed = true;
        else if (['false', 'off', 'no', '0'].includes(lower)) parsed = false;
        else { await message.reply(`\`${key}\` must be on/off.`); return; }
      } else if (schema.type === 'choice') {
        parsed = rawValue.toLowerCase();
        if (!schema.choices.includes(parsed)) {
          await message.reply(`\`${key}\` must be one of: ${schema.choices.join(', ')}`);
          return;
        }
      } else {
        // string type
        parsed = rawValue;
      }

      const oldVal = S(key);
      settings[key] = parsed;
      saveSettings();

      const oldDisplay = typeof oldVal === 'boolean' ? (oldVal ? 'on' : 'off') : String(oldVal);
      const newDisplay = typeof parsed === 'boolean' ? (parsed ? 'on' : 'off') : String(parsed);

      await message.reply({
        embeds: [new EmbedBuilder().setColor(COLOR_SUCCESS).setTitle('Setting updated')
          .setDescription(`\`${key}\`\n**${oldDisplay}** \u2192 **${newDisplay}**`)]
      });
      return;
    }
  }

  // ─── Claude interaction gate — only in allowed channels ────────────
  // Commands (above) work anywhere. Actual Claude spawning is restricted.
  if (MAIN_CHANNEL_ID || ADMIN_CHANNEL_ID) {
    // Channels configured: only main channel, its threads, and DMs can spawn Claude
    if (!isDM && !isMainChannel && !isMainThread) {
      if (isAdminChannel) {
        await message.reply('This channel is for bot commands only. Use the main channel to talk to Claude.');
      }
      return;
    }
  } else {
    // No channels configured: fall back to mention/thread/DM behavior
    if (!isDM && !isMentioned && !isThread) return;
  }

  // ─── Handle file attachments ───────────────────────────────────────
  const attachments = [...message.attachments.values()];
  if (attachments.length > 0) {
    const downloadDir = '/tmp/discord-uploads';
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
    const fileLines = [];
    for (const att of attachments) {
      const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const dest = path.join(downloadDir, `${Date.now()}-${safeName}`);
      try {
        const res = await fetch(att.url);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(dest, buffer);
        fileLines.push(`[Attached file: "${att.name}" (${att.size} bytes) — downloaded to ${dest}]`);
      } catch (err) {
        fileLines.push(`[Attached file: "${att.name}" — download failed: ${err.message}]`);
      }
    }
    prompt = fileLines.join('\n') + (prompt ? '\n' + prompt : '');
  }

  if (!prompt) return;

  log('info', 'Message received', { user: message.author.tag, prompt: prompt.substring(0, 100) });

  let responseChannel = message.channel;
  let threadId = null;
  let isNewThread = false;

  if (!isDM && !isThread) {
    try {
      const threadName = prompt.substring(0, 95) + (prompt.length > 95 ? '...' : '');
      const thread = await message.startThread({
        name: threadName,
        autoArchiveDuration: 1440,
      });
      responseChannel = thread;
      threadId = thread.id;
      isNewThread = true;
    } catch (e) {
      log('error', 'Failed to create thread', { error: e.message });
      if (message.thread) {
        responseChannel = message.thread;
        threadId = message.thread.id;
      } else {
        log('error', 'No thread available, aborting');
        return;
      }
    }
  } else if (isThread) {
    threadId = message.channel.id;
    responseChannel = message.channel;
  }

  try {
    // ─── Rate limit gate ─────────────────────────────────────────────
    const cachedProbe = await getCachedProbe();
    const sessionRemaining = cachedProbe?.fiveHour ? (1 - cachedProbe.fiveHour.utilization) : 1;
    const weeklyRemaining = cachedProbe?.sevenDay ? (1 - cachedProbe.sevenDay.utilization) : 1;

    if (sessionRemaining <= 0.20 || weeklyRemaining <= 0.10) {
      const warnings = [];
      if (sessionRemaining <= 0.20) {
        warnings.push(`Session: **${(cachedProbe.fiveHour.utilization * 100).toFixed(0)}% used** (${(sessionRemaining * 100).toFixed(0)}% left)`);
      }
      if (weeklyRemaining <= 0.10) {
        warnings.push(`Weekly: **${(cachedProbe.sevenDay.utilization * 100).toFixed(0)}% used** (${(weeklyRemaining * 100).toFixed(0)}% left)`);
      }

      const confirmEmbed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setTitle('\u26a0\ufe0f Usage limit running low')
        .setDescription(warnings.join('\n') + '\n\nReply **yes** to proceed or **no** to cancel.');
      const confirmMsg = await responseChannel.send({ embeds: [confirmEmbed] });

      try {
        const collected = await responseChannel.awaitMessages({
          filter: (m) => m.author.id === ALLOWED_USER_ID && /^(yes|no|y|n)$/i.test(m.content.trim()),
          max: 1, time: 60000, errors: ['time'],
        });
        const reply = collected.first()?.content?.trim().toLowerCase();
        if (reply === 'no' || reply === 'n') {
          await confirmMsg.edit({
            embeds: [new EmbedBuilder().setColor(COLOR_INFO).setTitle('Cancelled').setDescription('Request not sent to Claude.')]
          });
          return;
        }
      } catch (e) {
        await confirmMsg.edit({
          embeds: [new EmbedBuilder().setColor(COLOR_INFO).setTitle('Timed out').setDescription('No response — request cancelled.')]
        });
        return;
      }
    }

    // ─── Auto-compact if needed ──────────────────────────────────────
    if (threadId && sessions[threadId]?.needsAutoCompact) {
      sessions[threadId].needsAutoCompact = false;
      saveSessions();
      const pct = sessions[threadId]?.usage?.percent;
      const autoMsg = await responseChannel.send({
        embeds: [new EmbedBuilder().setColor(COLOR_WORKING)
          .setTitle(`Auto-compacting (context at ${pct ? (pct * 100).toFixed(0) : '90'}%)...`)]
      });
      try {
        const { oldPct, newPct } = await compactSession(threadId, responseChannel);
        await autoMsg.edit({
          embeds: [new EmbedBuilder().setColor(COLOR_SUCCESS)
            .setTitle('Auto-compact complete').setDescription(`Context: **${oldPct}** \u2192 **${newPct}**`).setTimestamp()]
        });
      } catch (err) {
        await autoMsg.edit({
          embeds: [new EmbedBuilder().setColor(COLOR_ERROR).setTitle('Auto-compact failed').setDescription(err.message.substring(0, 2000))]
        });
      }
    }

    const existingSession = threadId ? getSessionId(threadId) : null;
    const existingUsage = threadId ? getSessionUsage(threadId) : null;
    const sessionCwd = threadId ? sessions[threadId]?.cwd : null;
    const sessionModel = (threadId ? sessions[threadId]?.model : null) || (S('default_model') !== 'opus' ? S('default_model') : null);

    // Inject context warning into prompt when resuming high-usage sessions
    let augmentedPrompt = prompt;
    if (existingUsage?.percent >= S('context_warn')) {
      augmentedPrompt = `[SYSTEM NOTE: Context usage is at ${(existingUsage.percent * 100).toFixed(1)}% of the ${formatTokens(existingUsage.contextWindow || 1000000)} window. Be extra concise. Avoid spawning new Agent sub-processes unless absolutely necessary. If the user's request would require heavy context (reading many files, multi-agent work), suggest running /compact first.]\n\n${prompt}`;
    }

    const { finalText, sessionId, images, usage } = await enqueueOrRun(
      augmentedPrompt, existingSession, responseChannel,
      { threadId, cwd: sessionCwd, model: sessionModel, existingContextPercent: existingUsage?.percent || 0 }
    );

    if (threadId && sessionId) {
      const prev = sessions[threadId] || {};
      sessions[threadId] = { ...prev, sessionId, usage };
      // Flag for auto-compact if context is critically high
      if (usage?.percent >= S('auto_compact')) {
        sessions[threadId].needsAutoCompact = true;
      }
      saveSessions();
    }

    // Context warning at 80%
    if (usage?.percent >= S('context_warn') && usage?.percent < S('auto_compact')) {
      const warnEmbed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setTitle('\u26a0\ufe0f Context usage high')
        .setDescription(`${contextBar(usage.percent)}\n\nConsider:\n\`/compact\` — summarize & start fresh\n\`/context\` — see detailed usage`)
        .setTimestamp();
      await responseChannel.send({ embeds: [warnEmbed] });
    }

    // Send final response
    if (finalText) {
      const chunks = splitMessage(finalText);
      for (const chunk of chunks) {
        const files = [];
        if (chunk === chunks[chunks.length - 1] && images.length > 0) {
          for (const img of images) {
            try {
              if (fs.existsSync(img)) files.push(new AttachmentBuilder(img));
            } catch (e) {}
          }
        }
        await responseChannel.send({ content: chunk, files });
      }
    }

    // ─── Thread auto-naming ──────────────────────────────────────────
    if (S('auto_rename_threads') && isNewThread && finalText && responseChannel.isThread()) {
      try {
        const firstLine = finalText.split(/[.\n]/).find(s => s.trim().length > 10)?.trim() || finalText.trim();
        const newName = firstLine.substring(0, 95) + (firstLine.length > 95 ? '...' : '');
        if (newName.length > 5) await responseChannel.setName(newName);
      } catch (e) {
        log('error', 'Failed to rename thread', { error: e.message });
      }
    }

  } catch (err) {
    log('error', 'Message handler error', { error: err.message });
    try {
      const errorEmbed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setTitle('Failed')
        .setDescription(err.message.substring(0, 4000))
        .setTimestamp();
      await responseChannel.send({ embeds: [errorEmbed] });
    } catch (e) {
      log('error', 'Failed to send error embed', { error: e.message });
    }
  }
});

// ─── System prompt ───────────────────────────────────────────────────

// Load custom system prompt extension if it exists (for per-deployment infra details)
const CUSTOM_PROMPT_FILE = path.join(__dirname, 'system-prompt.md');
const CUSTOM_PROMPT = (() => {
  try { return fs.existsSync(CUSTOM_PROMPT_FILE) ? fs.readFileSync(CUSTOM_PROMPT_FILE, 'utf8') : ''; }
  catch { return ''; }
})();

const DISCORD_SYSTEM_PROMPT = `You are Claude Code running on a server called "${SERVER_NAME}", responding via Discord to your owner ${BOT_OWNER}.

IMPORTANT: You are running in non-interactive mode. You cannot use interactive prompts, stdin, or tool-based questions (like AskUserQuestion). If you need to ask ${BOT_OWNER} something, just say it in your response text — they will reply in the Discord thread and you will receive it as your next message. It is OK to stop and ask before doing work. Just write your question as normal text output.

Keep your final text response concise — summarize what you did, what URL the app is at, and any issues. Do NOT list every file you created or dump code. If you need more detail, keep it focused and organized. The bot will split long messages automatically.

Format ALL output for Discord:
- NEVER use markdown tables (| col | col |). Discord does not render them.
- For tabular data, use a code block with simple aligned columns like:
\`\`\`
Key        Value
Another    Value
\`\`\`
- Keep lines under 40 characters when possible. Wrap long values to the next line.
- Use Discord markdown: **bold**, *italic*, \`inline code\`, > quotes, # headers.
- Use \`\`\` code blocks for command output, logs, and data.
- Keep responses concise. Discord messages have a 2000 character limit.
- You CAN send images/screenshots to Discord! When you want to share an image, just include the absolute file path in your response (e.g. /tmp/screenshot.png). The bot will automatically detect paths ending in .png, .jpg, .jpeg, .gif, .webp and upload them as Discord attachments. Always mention the file path in your response text when you want to share an image.

${CUSTOM_PROMPT ? CUSTOM_PROMPT : ''}

## Context Management
You are running in a Discord bot with limited visibility into your context usage. Be mindful of context consumption:
- **Read only what you need.** Use targeted line ranges (offset/limit) instead of reading entire large files. Use Grep/Glob to find what you need before reading.
- **Avoid redundant reads.** If you already read a file in this conversation, don't re-read it unless it may have changed.
- **Keep Agent spawns lean.** Sub-agents consume context. Only spawn agents when the task genuinely requires parallel work or deep exploration. For simple searches, use Grep/Glob directly.
- **Prefer Edit over Write** for existing files — it sends only the diff, not the whole file.
- **Don't dump large outputs.** When running Bash commands, pipe through head/tail or redirect to a file if the output could be large.
- **If context feels high** (you've done many tool calls, read many files, or spawned several agents), tell Tom: "Context is getting heavy — consider running /compact to free up space, or I can try to wrap up concisely."`;

// ─── Streaming Claude runner with live embed ─────────────────────────

function runClaudeStreaming(prompt, sessionId, channel, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
      '--max-turns', String(S('max_turns')), '--system-prompt', DISCORD_SYSTEM_PROMPT];

    if (sessionId) args.push('--resume', sessionId);
    if (options.model) args.push('--model', options.model);

    const cwd = options.cwd || HOME_DIR;

    log('info', 'Spawning Claude', { cwd, model: options.model || 'default', prompt: prompt.substring(0, 80) });

    const proc = spawn(CLAUDE_PATH, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: HOME_DIR,
        PATH: `${path.join(HOME_DIR, '.local/bin')}:${process.env.PATH}`,
      },
    });

    proc.stdin.end();

    // Track active process
    if (options.threadId) {
      activeProcesses.set(options.threadId, { proc, channel, startTime: Date.now() });
    }

    // ─── State ───
    const startTime = Date.now();
    let lastActivity = Date.now();
    let finalText = '';
    let newSessionId = sessionId;
    const images = [];
    let usageData = null;

    let currentPhase = 'starting';
    let toolCallCount = 0;
    const activityLog = [];
    let currentAction = '';
    let thinkingSnippets = [];
    let stderr = '';
    let contextPercent = options.existingContextPercent || 0;

    // Streaming text state
    let accumulatedText = '';
    let partialMessage = null;
    let lastPartialFlush = 0;

    // Embed message handle
    let statusMessage = null;
    let embedSendPending = false;

    const modelTag = options.model && options.model !== 'opus' ? ` (${options.model})` : '';

    // ─── Build the live embed ───
    function buildEmbed() {
      const elapsed = formatElapsed(Date.now() - startTime);
      let color, title;
      const ctxTag = contextPercent > 0 ? ` \u00b7 ${(contextPercent * 100).toFixed(0)}% ctx` : '';

      switch (currentPhase) {
        case 'starting':
          color = COLOR_STARTING;
          title = `Initializing${modelTag}`;
          if (contextPercent > 0) title += ` \u00b7 ${(contextPercent * 100).toFixed(0)}% ctx`;
          break;
        case 'thinking':
          color = COLOR_THINKING;
          title = `Thinking${modelTag} \u2014 ${elapsed}${ctxTag}`;
          break;
        case 'working':
          color = contextPercent >= S('context_warn') ? COLOR_ERROR : COLOR_WORKING;
          title = `Working${modelTag} \u2014 ${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''} \u2014 ${elapsed}${ctxTag}`;
          break;
        case 'done':
          color = COLOR_SUCCESS;
          title = `Done${modelTag} \u2014 ${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''} in ${elapsed}${ctxTag}`;
          break;
        case 'error':
          color = COLOR_ERROR;
          title = `Failed after ${elapsed}`;
          break;
      }

      const embed = new EmbedBuilder().setColor(color).setTitle(title);

      // Show context bar on initializing and thinking
      if (contextPercent > 0 && (currentPhase === 'starting' || currentPhase === 'thinking')) {
        embed.addFields({ name: 'Session Context', value: contextBar(contextPercent), inline: false });
      }

      if (currentAction && currentPhase !== 'done' && currentPhase !== 'error') {
        embed.addFields({ name: 'Current', value: currentAction, inline: false });
      }

      if (activityLog.length > 1) {
        const history = activityLog.slice(0, -1);
        const visible = history.slice(-15);
        const hidden = history.length - visible.length;
        let logText = visible.join('\n');
        if (hidden > 0) logText = `*... ${hidden} earlier*\n` + logText;
        if (logText.length > 1024) logText = '...' + logText.substring(logText.length - 1020);
        embed.addFields({ name: 'Activity', value: logText, inline: false });
      } else if (activityLog.length === 1 && (currentPhase === 'done' || currentPhase === 'error')) {
        embed.addFields({ name: 'Activity', value: activityLog[0], inline: false });
      }

      if (currentPhase === 'done' && activityLog.length > 1) {
        embed.spliceFields(0, embed.data.fields?.length || 0);
        const visible = activityLog.slice(-20);
        const hidden = activityLog.length - visible.length;
        let logText = visible.join('\n');
        if (hidden > 0) logText = `*... ${hidden} earlier*\n` + logText;
        if (logText.length > 1024) logText = '...' + logText.substring(logText.length - 1020);
        embed.addFields({ name: 'Activity', value: logText, inline: false });
      }

      return embed;
    }

    async function syncEmbed() {
      if (embedSendPending) return;
      embedSendPending = true;
      try {
        const embed = buildEmbed();
        if (!statusMessage) {
          statusMessage = await channel.send({ embeds: [embed] });
          // Add stop reaction for cancel-by-reaction
          try { await statusMessage.react('\ud83d\uded1'); } catch (e) {}
        } else {
          await statusMessage.edit({ embeds: [embed] });
        }
      } catch (e) {
        log('error', 'Embed sync failed', { error: e.message });
      } finally {
        embedSendPending = false;
      }
    }

    // Flush partial streaming text to Discord
    async function flushPartialText() {
      if (accumulatedText.length < 50) return;
      lastPartialFlush = Date.now();
      const preview = accumulatedText.length > 1800
        ? '...' + accumulatedText.substring(accumulatedText.length - 1800)
        : accumulatedText;
      const content = preview.substring(0, 1950);
      try {
        if (!partialMessage) {
          partialMessage = await channel.send({ content });
        } else {
          await partialMessage.edit({ content });
        }
      } catch (e) {}
    }

    syncEmbed();

    const typingInterval = setInterval(async () => {
      try { await channel.sendTyping(); } catch (e) {}
    }, 4000);
    channel.sendTyping().catch(() => {});

    const tick = setInterval(() => { syncEmbed(); }, TIMER_TICK);

    const idleCheck = setInterval(() => {
      if (Date.now() - lastActivity > S('idle_timeout') * 1000) {
        log('info', 'Killing Claude process due to idle timeout');
        proc.kill('SIGTERM');
        clearInterval(idleCheck);
      }
    }, 10000);

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      lastActivity = Date.now();
    });

    // ─── Parse streaming JSON ───
    const rl = readline.createInterface({ input: proc.stdout });

    rl.on('line', (line) => {
      lastActivity = Date.now();

      try {
        const event = JSON.parse(line);

        if (event.type === 'assistant' && event.message?.content) {
          if (event.message.usage) {
            const u = event.message.usage;
            const totalIn = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            if (totalIn > 0) contextPercent = totalIn / 1000000;
          }

          // Check if this message has any tool_use blocks — if so, text is just narration
          const hasToolUse = event.message.content.some(b => b.type === 'tool_use');

          for (const block of event.message.content) {
            if (block.type === 'thinking' && block.thinking) {
              if (currentPhase === 'starting') currentPhase = 'thinking';
              const snippet = block.thinking.substring(0, 300).trim();
              if (snippet) thinkingSnippets.push(snippet);
            }

            // Streaming text output — only stream when this is a text-only message (final response),
            // not the narration between tool calls
            if (block.type === 'text' && block.text && !hasToolUse) {
              accumulatedText += block.text;
              if (S('streaming_text') && Date.now() - lastPartialFlush > S('partial_flush_interval') * 1000) {
                flushPartialText();
              }
            }

            if (block.type === 'tool_use') {
              const toolName = block.name || '';
              const input = block.input || {};
              const icon = TOOL_ICONS[toolName] || TOOL_ICONS.default;
              let desc = `${icon} ${toolName}`;

              if (toolName === 'Write' && input.file_path) {
                desc = `${icon} Write \`${path.basename(input.file_path)}\``;
              } else if (toolName === 'Edit' && input.file_path) {
                desc = `${icon} Edit \`${path.basename(input.file_path)}\``;
              } else if (toolName === 'Read' && input.file_path) {
                desc = `${icon} Read \`${path.basename(input.file_path)}\``;
              } else if (toolName === 'Bash' && input.command) {
                const cmd = input.command.substring(0, 80);
                desc = `${icon} \`${cmd}\`${input.command.length > 80 ? '\u2026' : ''}`;
              } else if (toolName === 'Glob') {
                desc = `${icon} Glob \`${input.pattern || ''}\``;
              } else if (toolName === 'Grep') {
                desc = `${icon} Grep \`${input.pattern || ''}\``;
              } else if (toolName === 'Agent') {
                desc = `${icon} Agent \u2014 ${(input.description || '').substring(0, 60)}`;
              } else if (toolName === 'WebFetch') {
                desc = `${icon} Fetch ${(input.url || '').substring(0, 60)}`;
              } else if (toolName === 'WebSearch') {
                desc = `${icon} Search: ${(input.query || '').substring(0, 60)}`;
              }

              toolCallCount++;
              activityLog.push(desc);
              currentAction = desc;
              currentPhase = 'working';
              syncEmbed();
            }
          }
        }

        if (event.type === 'rate_limit_event' && event.rate_limit_info) {
          lastRateLimit = event.rate_limit_info;
        }

        if (event.type === 'result') {
          finalText = event.result || '';
          newSessionId = event.session_id || sessionId;

          const mu = event.modelUsage;
          if (mu) {
            const modelKey = Object.keys(mu)[0];
            if (modelKey) {
              const m = mu[modelKey];
              const ctxWindow = m.contextWindow || 1000000;
              const totalIn = (m.inputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0);
              contextPercent = totalIn / ctxWindow;
              usageData = {
                input: m.inputTokens || 0,
                output: m.outputTokens || 0,
                cacheRead: m.cacheReadInputTokens || 0,
                cacheCreate: m.cacheCreationInputTokens || 0,
                contextWindow: ctxWindow,
                percent: contextPercent,
                costUSD: m.costUSD || event.total_cost_usd || 0,
              };
            }
          } else if (event.usage) {
            const u = event.usage;
            const totalIn = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            contextPercent = totalIn / 1000000;
            usageData = {
              input: u.input_tokens || 0,
              output: u.output_tokens || 0,
              cacheRead: u.cache_read_input_tokens || 0,
              cacheCreate: u.cache_creation_input_tokens || 0,
              contextWindow: 1000000,
              percent: contextPercent,
              costUSD: event.total_cost_usd || 0,
            };
          }
        }
      } catch (e) {
        // Not valid JSON — ignore
      }
    });

    // ─── Process exit ───
    proc.on('close', async (code) => {
      clearInterval(idleCheck);
      clearInterval(tick);
      clearInterval(typingInterval);

      // Cleanup active process tracking
      if (options.threadId) activeProcesses.delete(options.threadId);

      currentPhase = (code === 0 || finalText) ? 'done' : 'error';
      currentAction = '';
      await syncEmbed();

      // Remove stop reaction when done
      if (statusMessage) {
        try { await statusMessage.reactions.cache.get('\ud83d\uded1')?.remove(); } catch (e) {}
      }

      // Delete partial streaming message before sending final
      if (partialMessage) {
        try { await partialMessage.delete(); } catch (e) {}
      }

      // Send thinking as spoiler
      if (thinkingSnippets.length > 0) {
        const thinkingText = thinkingSnippets.map(s => s.replace(/\n/g, ' ')).join('\n\n');
        const truncated = thinkingText.substring(0, 1800);
        try {
          await channel.send(`**Thinking**\n||${truncated}${thinkingText.length > 1800 ? '\u2026' : ''}||`);
        } catch (e) {
          log('error', 'Failed to send thinking', { error: e.message });
        }
      }

      if (code !== 0 && !finalText) {
        let errMsg;
        if (code === 143 || code === null) {
          errMsg = 'Claude was killed (likely idle timeout or OOM). The task may have had a long-running command with no output. Say **continue** to resume.';
        } else {
          errMsg = stderr || `Claude exited with code ${code}`;
        }
        reject(new Error(errMsg));
        dequeueNext();
        return;
      }

      // Detect image paths
      const imgRegex = /(?:\/(?:home|tmp|var|opt)[^\s"'`\)]+\.(?:png|jpg|jpeg|gif|webp))/gi;
      const allText = (finalText || '') + ' ' + prompt;
      const matches = allText.match(imgRegex) || [];
      const seen = new Set();
      for (const m of matches) {
        if (!seen.has(m)) { seen.add(m); images.push(m); }
      }

      // Log usage
      if (usageData) {
        logUsage({
          inputTokens: usageData.input,
          outputTokens: usageData.output,
          cacheRead: usageData.cacheRead,
          cacheCreate: usageData.cacheCreate,
          costUSD: usageData.costUSD,
          durationMs: Date.now() - startTime,
          sessionId: newSessionId,
        });
      }

      resolve({ finalText, sessionId: newSessionId, images, usage: usageData });
      dequeueNext();
    });

    proc.on('error', async (err) => {
      clearInterval(idleCheck);
      clearInterval(tick);
      clearInterval(typingInterval);
      if (partialMessage) { try { await partialMessage.delete(); } catch (e) {} }
      if (statusMessage) { try { await statusMessage.reactions.cache.get('\ud83d\uded1')?.remove(); } catch (e) {} }
      if (options.threadId) activeProcesses.delete(options.threadId);
      reject(err);
      dequeueNext();
    });
  });
}

// ─── Message splitting ───────────────────────────────────────────────

function splitMessage(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitIndex === -1 || splitIndex < MAX_MESSAGE_LENGTH / 2) {
      splitIndex = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    }
    if (splitIndex === -1 || splitIndex < MAX_MESSAGE_LENGTH / 2) {
      splitIndex = MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }

  return chunks;
}

client.login(process.env.DISCORD_TOKEN);
