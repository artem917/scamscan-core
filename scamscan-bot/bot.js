const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const config = require('./config');
const { checkValue } = require('./services/apiClient');
const { logFeedback } = require('./services/feedbackLogger');
const { detectInputType, formatCheckResult } = require('./utils/format');

// Admins (Telegram user IDs)
const ADMIN_IDS = [373229100, 346722278]; // Артём и 346722278

// ===== In-memory state & usage =====
const stateByChat = {};
const lastCheckByChat = {};
let usage = loadUsage();
let proUsers = loadProUsers();

// ===== Helpers: dates & storage =====
function getToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}

function loadUsage() {
  try {
    const raw = fs.readFileSync(config.usageFilePath, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    console.error('Cannot read usage file, starting empty:', e.message);
    return {};
  }
}

function saveUsage() {
  try {
    fs.writeFileSync(config.usageFilePath, JSON.stringify(usage, null, 2), 'utf8');
  } catch (e) {
    console.error('Cannot write usage file:', e.message);
  }
}

function loadProUsers() {
  try {
    const raw = fs.readFileSync(config.proUsersFilePath, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.map((x) => String(x));
    }
    return [];
  } catch (e) {
    console.error('Cannot read pro_users file, starting empty:', e.message);
    return [];
  }
}

function isProUser(userId) {
  const idStr = String(userId);
  return Array.isArray(proUsers) && proUsers.includes(idStr);
}

// Usage per day & user
function getOrCreateUsageEntry(userId) {
  const day = getToday();
  const idStr = String(userId);
  if (!usage[day]) usage[day] = {};
  if (!usage[day][idStr]) usage[day][idStr] = { count: 0 };
  return usage[day][idStr];
}

function getLimitInfoForUser(userId) {
  const entry = getOrCreateUsageEntry(userId);
  const used = entry.count || 0;
  const maxFree = config.maxFreeChecksPerDay;
  const remaining = Math.max(0, maxFree - used);
  const limitReached = used >= maxFree;
  return { entry, used, remaining, maxFree, limitReached };
}

// ===== Helpers: state & keyboards =====
function getState(chatId) {
  const key = String(chatId);
  if (!stateByChat[key]) {
    stateByChat[key] = {
      mode: 'auto',
      awaitingFeedback: false,
      awaitingTesterInfo: false,
      awaitingSupport: false,
      replyingTo: null,
    };
  }
  return stateByChat[key];
}

function mainKeyboard() {
  return Markup.keyboard([
    ['🔗 URL', '👛 Wallet', '📜 Contract'],
    ['🤖 Auto-detect', '🆘 Support'],
    ['📊 Admin'],
  ]).resize();
}

function resultKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👍 All good', callback_data: 'FEEDBACK_OK' }],
        [{ text: '⚠️ Dispute result', callback_data: 'FEEDBACK_DISPUTE' }],
      ],
    },
  };
}

function notifyAdmins(text, replyUserId = null) {
  ADMIN_IDS.forEach((adminId) => {
    const id = Number(adminId);
    const extra = { disable_web_page_preview: true };
    
    if (replyUserId) {
      extra.reply_markup = {
        inline_keyboard: [[
          { text: '✉️ Reply to ' + replyUserId, callback_data: 'ADMIN_REPLY_' + replyUserId }
        ]]
      };
    }

    bot.telegram
      .sendMessage(id, text, extra)
      .catch((err) => {
        console.error('Failed to notify admin', adminId, err.message);
      });
  });
}

// ===== Admin helpers =====
async function sendBotStats(ctx) {
  if (!ensureAdmin(ctx)) return;

  const allDays = Object.keys(usage || {});
  const seenUsers = new Set();
  let totalChecksToday = 0;
  const today = getToday();
  for (const day of allDays) {
    const dayUsage = usage[day] || {};
    for (const userId of Object.keys(dayUsage)) {
      seenUsers.add(userId);
      const entry = dayUsage[userId];
      if (day === today && entry && typeof entry.count === 'number') {
        totalChecksToday += entry.count;
      }
    }
  }

  const totalUsers = seenUsers.size;
  const proCount = Array.isArray(proUsers) ? proUsers.length : 0;
  
  const msg = 
    '<b>📊 ScamScan Stats:</b>\n' +
    '• Users total: ' + totalUsers + '\n' +
    '• PRO users: ' + proCount + '\n' +
    '• Checks today: ' + totalChecksToday;
    
  await ctx.reply(msg, { parse_mode: 'HTML' });
}

function getAdminHelpText() {
  return (
    '<b>🛠 Admin Panel Commands:</b>\n\n' +
    '📊 <b>/stats</b> — Show bot statistics\n' +
    '📜 <b>/prolist</b> — List all PRO users\n' +
    '👑 <b>/setpro ID</b> — Grant PRO status\n' +
    '🚫 <b>/unsetpro ID</b> — Revoke PRO status\n' +
    '🔄 <b>/resetlimit ID</b> — Reset daily limit\n' +
    '✉️ <b>/reply ID text</b> — Manual reply without button'
  );
}

function ensureAdmin(ctx) {
  const from = ctx.from || {};
  const idNum = Number(from.id);
  const idStr = String(from.id);
  if (!ADMIN_IDS.includes(idNum) && !ADMIN_IDS.includes(idStr)) {
    return false;
  }
  return true;
}

function resetUserLimitById(userId) {
  const idStr = String(userId);
  let changed = false;
  const allDays = Object.keys(usage || {});
  for (const day of allDays) {
    const dayUsage = usage[day] || {};
    if (Object.prototype.hasOwnProperty.call(dayUsage, idStr)) {
      delete dayUsage[idStr];
      changed = true;
    }
  }
  if (changed) saveUsage();
  return changed;
}

function persistProUsers() {
  try {
    fs.writeFileSync(config.proUsersFilePath, JSON.stringify(proUsers, null, 2), 'utf8');
  } catch (e) {
    console.error('Cannot write pro_users file:', e.message);
  }
}

function setProFlag(userId, flag) {
  const idStr = String(userId);
  if (!Array.isArray(proUsers)) proUsers = [];
  
  const idx = proUsers.indexOf(idStr);
  let changed = false;
  if (flag) {
    if (idx === -1) {
      proUsers.push(idStr);
      changed = true;
    }
  } else {
    if (idx !== -1) {
      proUsers.splice(idx, 1);
      changed = true;
    }
  }
  if (changed) persistProUsers();
  return flag;
}

// ===== Bot init =====
const bot = new Telegraf(config.botToken);

// ===== Commands: public =====
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const state = getState(chatId);
  state.mode = 'auto';
  state.awaitingFeedback = false;
  state.awaitingTesterInfo = false;
  state.awaitingSupport = false;
  state.replyingTo = null;
  const text = `Hi! I am the Telegram bot for ScamScan (beta, for early testers).\n\nSend me a URL, wallet address or contract address and I will call the ScamScan engine and return a risk assessment.\n\nYou can:\n\n• Just paste what you want to check and let me auto-detect the type\n\n• Or use the keyboard below to explicitly choose URL / wallet / contract.`;
  await ctx.reply(text, mainKeyboard());
});

bot.command('help', async (ctx) => {
  const text =
    'How to use ScamScan bot:\n\n' +
    '1) Paste a URL, wallet or contract.\n' +
    '2) I will analyze it using ScamScan and return a short risk summary.\n\n' +
    'Feedback is welcome via the 🆘 Support button.';
  await ctx.reply(text, mainKeyboard());
});

bot.command('whoami', async (ctx) => {
  const from = ctx.from || {};
  const parts = [
    'Telegram user info:',
    'id: ' + from.id,
    from.username ? 'username: @' + from.username : null,
  ].filter(Boolean);
  await ctx.reply(parts.join('\n'));
});

bot.command('tester', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = getState(chatId);
  state.awaitingTesterInfo = true;
  await ctx.reply(
    'To apply for PRO tester access, send a short message about yourself.',
    mainKeyboard()
  );
});

bot.command('support', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = getState(chatId);
  state.awaitingSupport = true;
  await ctx.reply(
    'Please describe your question or issue.',
    mainKeyboard()
  );
});

// ===== Commands: admin =====
bot.command('stats', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  await sendBotStats(ctx);
});

bot.command('admin', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  await ctx.reply(getAdminHelpText(), { parse_mode: 'HTML' });
});

bot.command('resetlimit', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const msgText = (ctx.message && ctx.message.text) || '';
  const parts = msgText.trim().split(/\s+/);
  const userId = parts[1];
  if (!userId || !/^\d+$/.test(userId)) {
    await ctx.reply('Usage: /resetlimit <telegramUserId>');
    return;
  }
  const changed = resetUserLimitById(userId);
  if (changed) {
    await ctx.reply('✅ Limit reset for ' + userId);
  } else {
    await ctx.reply('⚠️ No usage found for ' + userId);
  }
});

bot.command('setpro', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const msgText = (ctx.message && ctx.message.text) || '';
  const parts = msgText.trim().split(/\s+/);
  const userId = parts[1];
  if (!userId || !/^\d+$/.test(userId)) {
    await ctx.reply('Usage: /setpro <telegramUserId>');
    return;
  }
  setProFlag(userId, true);
  await ctx.reply('✅ User ' + userId + ' is now PRO.');
});

bot.command('unsetpro', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const msgText = (ctx.message && ctx.message.text) || '';
  const parts = msgText.trim().split(/\s+/);
  const userId = parts[1];
  if (!userId || !/^\d+$/.test(userId)) {
    await ctx.reply('Usage: /unsetpro <telegramUserId>');
    return;
  }
  setProFlag(userId, false);
  await ctx.reply('ℹ️ User ' + userId + ' is now regular.');
});

bot.command('prolist', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const ids = proUsers || [];
  if (ids.length === 0) {
    await ctx.reply('No PRO users yet.');
    return;
  }
  const lines = ids.map((id) => '- ' + id);
  const msg = '<b>PRO users (' + ids.length + '):</b>\n' + lines.join('\n');
  await ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.command('reply', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const text = (ctx.message && ctx.message.text) || '';
  const match = text.match(/^\/reply\s+(\d+)\s+([\s\S]+)/);
  if (!match) {
    await ctx.reply('Usage: /reply hatId> <message>');
    return;
  }
  const chatId = match[1];
  const replyText = match[2];
  try {
    await bot.telegram.sendMessage(chatId, '📩 <b>Support reply:</b>\n\n' + replyText, { parse_mode: 'HTML' });
    await ctx.reply('✅ Sent to ' + chatId);
  } catch (err) {
    await ctx.reply('❌ Error: ' + err.message);
  }
});

// ===== Keyboard buttons handlers =====
bot.hears('🔗 URL', async (ctx) => {
  const state = getState(ctx.chat.id);
  state.mode = 'url';
  await ctx.reply('Mode: URL check. Send link.', mainKeyboard());
});

bot.hears('👛 Wallet', async (ctx) => {
  const state = getState(ctx.chat.id);
  state.mode = 'wallet';
  await ctx.reply('Mode: Wallet check. Send address.', mainKeyboard());
});

bot.hears('📜 Contract', async (ctx) => {
  const state = getState(ctx.chat.id);
  state.mode = 'contract';
  await ctx.reply('Mode: Contract check. Send address.', mainKeyboard());
});

bot.hears('🤖 Auto-detect', async (ctx) => {
  const state = getState(ctx.chat.id);
  state.mode = 'auto';
  await ctx.reply('Mode: Auto-detect.', mainKeyboard());
});

bot.hears('🆘 Support', async (ctx) => {
  const state = getState(ctx.chat.id);
  state.awaitingSupport = true;
  await ctx.reply('Please describe your question or issue.', mainKeyboard());
});

// ===== Feedback & Admin Reply callbacks =====
bot.action('FEEDBACK_OK', async (ctx) => {
  try { await ctx.answerCbQuery('Thanks!'); } catch (e) {}
  logFeedback({ type: 'rating', rating: 'ok', from: ctx.from });
});

bot.action('FEEDBACK_DISPUTE', async (ctx) => {
  try { await ctx.answerCbQuery('Send details'); } catch (e) {}
  const state = getState(ctx.chat.id);
  state.awaitingFeedback = true;
  await ctx.reply('Describe the issue in next message.');
});

bot.action(/^ADMIN_REPLY_(\d+)$/, async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const userId = ctx.match[1];
  const state = getState(ctx.chat.id);
  state.replyingTo = userId;
  await ctx.reply('📝 Write your reply for user ' + userId + ':', mainKeyboard());
  try { await ctx.answerCbQuery(); } catch (e) {}
});

// ===== Main text handler =====
bot.on('text', async (ctx) => {
  const msg = ctx.message || {};
  const text = (msg.text || '').trim();
  const chatId = ctx.chat.id;
  const from = ctx.from || {};
  const state = getState(chatId);

  if (text.startsWith('/')) return;

  // Admin Button
  if (text === '📊 Admin') {
    if (!ensureAdmin(ctx)) return;
    await sendBotStats(ctx);
    return ctx.reply(getAdminHelpText(), { parse_mode: 'HTML' });
  }
  
  // Admin Reply
  if (state.replyingTo) {
    const targetId = state.replyingTo;
    state.replyingTo = null; 
    try {
      await bot.telegram.sendMessage(targetId, '📩 <b>Support reply:</b>\n\n' + text, { parse_mode: 'HTML' });
      await ctx.reply('✅ Reply sent to user ' + targetId);
      notifyAdmins(`Admin ${from.id} replied to ${targetId}: "${text}"`);
    } catch (err) {
      await ctx.reply('❌ Failed to send reply: ' + err.message);
    }
    return;
  }

  // 1) Dispute
  if (state.awaitingFeedback) {
    state.awaitingFeedback = false;
    logFeedback({ type: 'dispute', from, message: text });
    await ctx.reply('Thanks, feedback recorded.');
    return;
  }

  // 2) PRO request
  if (state.awaitingTesterInfo) {
    state.awaitingTesterInfo = false;
    logFeedback({ type: 'tester_request', from, message: text });
    const info = `New PRO request from @${from.username} (${from.id}):\n\n${text}`;
    notifyAdmins(info, from.id);
    await ctx.reply('Request sent to team.');
    return;
  }

  // 3) Support
  if (state.awaitingSupport) {
    state.awaitingSupport = false;
    logFeedback({ type: 'support', from, message: text });
    const info = `Support msg from @${from.username} (${from.id}):\n\n${text}`;
    notifyAdmins(info, from.id);
    await ctx.reply('Message sent to support.');
    return;
  }

  // --- PROTECTION: FILTER JUNK TEXT ---
  // If text has cyrillic OR spaces (and not URL) -> treat as chatter, reject.
  const hasCyrillic = /[а-яА-ЯёЁ]/.test(text);
  const hasSpaces = /\s/.test(text);
  
  // Simpleheuristic: Real wallets/contracts/domains don't have spaces.
  // (Unless it's a seed phrase, but we ignore them for safety anyway)
  if (hasCyrillic || hasSpaces) {
    await ctx.reply(
      'I didn\'t recognize a wallet or URL in your message.\n\n' +
      '• To check an address: send just the address (no spaces).\n' +
      '• To contact support: click 🆘 Support.'
    );
    return;
  }
  // ------------------------------------

// 4) Check (API)
const forcedMode = state.mode;
const mode = forcedMode && forcedMode !== 'auto' ? forcedMode : null;
const inputType = detectInputType(text, mode);
const typeLabel = inputType || 'wallet';
const userId = from.id;
const pro = isProUser(userId);

let limitInfo = null;
let entry = null;

// Soft counting: we always track usage but do NOT block free users yet.
const limit = getLimitInfoForUser(userId);
entry = limit.entry;

let apiResult;

try {
  apiResult = await checkValue(typeLabel, text);
} catch (err) {
  console.error('API Error:', err);
  await ctx.reply('Service temporarily unavailable.');
  return;
}

if (entry) {
  entry.count = (entry.count || 0) + 1;
  saveUsage();
  const li2 = getLimitInfoForUser(userId);
  limitInfo = {
    used: li2.used,
    remaining: li2.remaining,
    maxFree: li2.maxFree,
  };
}

// Normalize API result for formatter: unwrap common wrappers like { status, data }, { result }, etc.
let coreData = apiResult;
if (coreData && typeof coreData === 'object') {
  if (coreData.data && typeof coreData.data === 'object') {
    coreData = coreData.data;
  } else if (coreData.result && typeof coreData.result === 'object') {
    coreData = coreData.result;
  } else if (coreData.payload && typeof coreData.payload === 'object') {
    coreData = coreData.payload;
  }
}

const message = formatCheckResult({
  type: typeLabel,
  input: text,
  data: coreData,
  isPro: pro,
  remaining: limitInfo ? limitInfo.remaining : null,
  maxFree: limitInfo ? limitInfo.maxFree : null,
});

lastCheckByChat[String(chatId)] = {
  time: new Date().toISOString(),
  input: text,
  type: typeLabel,
  result: apiResult,
};

const kb = resultKeyboard();
await ctx.reply(message, {
  parse_mode: 'Markdown',
  reply_markup: kb.reply_markup,
  disable_web_page_preview: false,
});

});

// ===== Launch =====
bot.launch()
  .then(() => console.log('ScamScan Telegram bot started'))
  .catch((err) => console.error('Failed to launch bot:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
