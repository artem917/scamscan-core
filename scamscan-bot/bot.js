const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const http = require('http');
const config = require('./config');
const { checkValue } = require('./services/apiClient');
const { logFeedback } = require('./services/feedbackLogger');

// Load or initialize user data
const DB_PATH = './data/users.json';

function loadUserDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { users: {} };
  }
}

function saveUserDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

// In-memory cache
let userDb = loadUserDb();

// Helpers
function getUser(id) {
  if (!userDb.users[id]) {
    userDb.users[id] = {
      id,
      isPro: false,
      checksToday: 0,
      lastCheckDate: null,
    };
  }
  return userDb.users[id];
}

function resetDailyLimitsIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  let changed = false;

  for (const id of Object.keys(userDb.users)) {
    const user = userDb.users[id];
    if (user.lastCheckDate !== today) {
      user.checksToday = 0;
      user.lastCheckDate = today;
      changed = true;
    }
  }

  if (changed) {
    saveUserDb(userDb);
  }
}

function incrementUserChecks(id) {
  resetDailyLimitsIfNeeded();
  const user = getUser(id);
  user.checksToday += 1;
  user.lastCheckDate = new Date().toISOString().slice(0, 10);
  saveUserDb(userDb);
}

function canUserCheck(id) {
  resetDailyLimitsIfNeeded();
  const user = getUser(id);
  if (user.isPro) return true;
  return user.checksToday < 5;
}

// Admins
const ADMINS = new Set([
  373229100, // Артём
  346722278, // Костя
]);

function isAdmin(ctx) {
  return ctx.from && ADMINS.has(ctx.from.id);
}

function ensureAdmin(ctx) {
  if (!isAdmin(ctx)) {
    ctx.reply('This command is for admins only.');
    return false;
  }
  return true;
}

// Reply keyboard
const mainKeyboard = Markup.keyboard([
  ['🔗 URL', '👛 Wallet', '📜 Contract'],
  ['🤖 Auto-detect', '🆘 Support'],
  ['📊 Admin'],
]).resize();

// ===== API health helpers (admin) =====
async function fetchApiHealth() {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:3000/api/health', (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (err) {
          reject(new Error('Cannot parse /api/health JSON: ' + err.message));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function formatApiHealthMessage() {
  try {
    const h = await fetchApiHealth();
    const status = (h && h.status) ? h.status : 'unknown';
    const uptimeSec = (h && typeof h.uptimeSec === 'number') ? h.uptimeSec : 0;
    const minutes = Math.floor(uptimeSec / 60);
    const seconds = uptimeSec % 60;
    const errors = (h && h.errors) ? h.errors : {};
    const totalRequests = (typeof errors.totalRequests === 'number') ? errors.totalRequests : null;
    const totalErrors = (typeof errors.totalErrors === 'number') ? errors.totalErrors : null;
    const lastErrorAt = errors.lastErrorAt || null;
    const lastErrorMessage = errors.lastErrorMessage || null;
    const rpcNetworks = (h && h.rpc && Array.isArray(h.rpc.networks)) ? h.rpc.networks.join(', ') : 'n/a';

    let msg = 'API Health\n\n';
    msg += 'Status: ' + status + '\n';
    msg += 'Uptime: ' + minutes + 'm ' + seconds + 's\n';
    msg += 'RPC networks: ' + rpcNetworks + '\n';

    if (totalRequests !== null) {
      msg += '\nRequests: ' + totalRequests + '\n';
      msg += 'Errors: ' + totalErrors + '\n';
    }
    if (lastErrorAt) {
      msg += '\nLast error at: ' + lastErrorAt + '\n';
      if (lastErrorMessage) {
        msg += 'Last error msg: ' + lastErrorMessage + '\n';
      }
    }

    return msg;
  } catch (err) {
    return 'Failed to call /api/health: ' + err.message;
  }
}

// Admin help text
function getAdminHelpText() {
  return (
    '<b>🛠 Admin Panel Commands:</b>\n\n' +
    '📊 <b>/stats</b> — Show bot statistics\n' +
    '📜 <b>/prolist</b> — List all PRO users\n' +
    '👑 <b>/setpro ID</b> — Grant PRO status\n' +
    '🚫 <b>/unsetpro ID</b> — Revoke PRO status\n' +
    '🔄 <b>/resetlimit ID</b> — Reset daily limit\n' +
    '🩺 <b>/apihealth</b> — Show API health\n' +
    '✉️ <b>/reply ID text</b> — Manual reply without button'
  );
}

// Create bot with token from config
const rawToken =
  (config && (config.BOT_TOKEN || config.TELEGRAM_BOT_TOKEN || config.TOKEN || config.token)) ||
  process.env.SCAMSCAN_BOT_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.TELEGRAM_TOKEN;

if (!rawToken) {
  console.error('Bot token not found in config.js or environment variables');
  process.exit(1);
}

const bot = new Telegraf(rawToken);

// ===== User commands =====
bot.start(async (ctx) => {
  const user = getUser(ctx.from.id);
  const proLabel = user.isPro ? 'PRO user' : 'free user';
  await ctx.reply(
    'Hi! I am the Telegram bot for ScamScan (beta, for early testers).\n\n' +
      'Send me a URL, wallet address or contract address and I will call the ScamScan engine and return a risk assessment.\n\n' +
      'You are currently a ' +
      proLabel +
      '. Free users have a limited number of checks per day. PRO users can use the bot without limits.',
    mainKeyboard
  );
});

bot.hears('🔗 URL', (ctx) =>
  ctx.reply('Send me a URL and I will analyze it.')
);
bot.hears('👛 Wallet', (ctx) =>
  ctx.reply('Send me a wallet address (Ethereum, BSC, Tron, TON, etc.) and I will analyze it.')
);
bot.hears('📜 Contract', (ctx) =>
  ctx.reply('Send me a smart-contract address (0x...) and I will analyze it.')
);
bot.hears('🤖 Auto-detect', (ctx) =>
  ctx.reply('Send me anything (URL, wallet, contract) and I will try to auto-detect the type.')
);
bot.hears('🆘 Support', (ctx) =>
  ctx.reply('If you have questions or feedback, just send a message and I will log it for review.')
);
bot.hears('📊 Admin', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  await ctx.reply(getAdminHelpText(), { parse_mode: 'HTML' });
});

// Admin commands: API health
bot.command('apihealth', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const msg = await formatApiHealthMessage();
  await ctx.reply(msg);
});

// ===== Commands: admin =====
bot.command('admin', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  await ctx.reply(getAdminHelpText(), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: 'API Health', callback_data: 'ADMIN_APIHEALTH' }]],
    },
  });
});

bot.action('ADMIN_APIHEALTH', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const msg = await formatApiHealthMessage();
  await ctx.reply(msg);
});

// Basic stats
bot.command('stats', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const totalUsers = Object.keys(userDb.users).length;
  const proUsers = Object.values(userDb.users).filter((u) => u.isPro).length;
  const today = new Date().toISOString().slice(0, 10);
  const checksToday = Object.values(userDb.users).reduce(
    (acc, u) => acc + (u.lastCheckDate === today ? u.checksToday : 0),
    0
  );

  await ctx.reply(
    '📊 ScamScan Stats:\n' +
      `• Users total: ${totalUsers}\n` +
      `• PRO users: ${proUsers}\n` +
      `• Checks today: ${checksToday}`,
    { parse_mode: 'HTML' }
  );
});

// List PRO users
bot.command('prolist', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const proUsers = Object.values(userDb.users).filter((u) => u.isPro);
  if (proUsers.length === 0) {
    await ctx.reply('No PRO users yet.');
    return;
  }
  const lines = proUsers.map((u) => `• ID: ${u.id}, checksToday: ${u.checksToday}`);
  await ctx.reply('PRO users:\n' + lines.join('\n'));
});

// Grant PRO
bot.command('setpro', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    await ctx.reply('Usage: /setpro ID');
    return;
  }
  const id = parts[1].trim();
  const user = getUser(id);
  user.isPro = true;
  saveUserDb(userDb);
  await ctx.reply(`User ${id} is now PRO.`);
});

// Revoke PRO
bot.command('unsetpro', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    await ctx.reply('Usage: /unsetpro ID');
    return;
  }
  const id = parts[1].trim();
  const user = getUser(id);
  user.isPro = false;
  saveUserDb(userDb);
  await ctx.reply(`User ${id} is no longer PRO.`);
});

// Reset daily limit
bot.command('resetlimit', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    await ctx.reply('Usage: /resetlimit ID');
    return;
  }
  const id = parts[1].trim();
  const user = getUser(id);
  user.checksToday = 0;
  user.lastCheckDate = null;
  saveUserDb(userDb);
  await ctx.reply(`Daily limit for user ${id} has been reset.`);
});

// Manual reply without button
bot.command('reply', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) {
    await ctx.reply('Usage: /reply ID text');
    return;
  }
  const id = parts[1].trim();
  const text = parts.slice(2).join(' ');
  try {
    await bot.telegram.sendMessage(id, text);
    await ctx.reply('Message sent.');
  } catch (e) {
    await ctx.reply('Failed to send message: ' + e.message);
  }
});

// Universal message handler
bot.on('text', async (ctx) => {
  const text = (ctx.message && ctx.message.text) || '';

  if (ADMINS.has(ctx.from.id)) {
    const adminCommands = ['/stats', '/prolist', '/setpro', '/unsetpro', '/resetlimit', '/reply', '/apihealth'];
    if (adminCommands.some((cmd) => text.startsWith(cmd))) {
      return;
    }
  }

  if (!canUserCheck(ctx.from.id)) {
    await ctx.reply('Daily limit reached. Upgrade to PRO to continue using the bot without limits.');
    return;
  }

  try {
    incrementUserChecks(ctx.from.id);
    const result = await checkValue(text);
    const summary = JSON.stringify(result, null, 2);
    await ctx.reply('Result:\n```\n' + summary + '\n```', { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await ctx.reply('Error while checking value: ' + e.message);
  }
});

// Feedback logging (simple example)
bot.on('message', async (ctx, next) => {
  try {
    const msg = ctx.message;
    if (msg && msg.text) {
      await logFeedback({
        userId: msg.from.id,
        username: msg.from.username || null,
        text: msg.text,
        date: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.error('Failed to log feedback:', e);
  }
  if (typeof next === 'function') {
    return next();
  }
});

// Launch bot
bot.launch().then(() => {
  console.log('ScamScan Telegram bot started');
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Admin inline button: API Health
bot.action('ADMIN_APIHEALTH', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const msg = await formatApiHealthMessage();
  await ctx.reply(msg, { parse_mode: 'HTML' });
});
