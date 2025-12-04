const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const config = require('./config');
const { checkValue } = require('./services/apiClient');
const { logFeedback } = require('./services/feedbackLogger');
const { detectInputType, formatCheckResult } = require('./utils/format');

const ADMIN_IDS = [373229100]; // твой Telegram ID

// ===== In-memory state & usage =====

const stateByChat = {};
const lastCheckByChat = {};
let usage = loadUsage();
let proUsers = loadProUsers();

function getToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
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
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('Cannot read pro_users file, starting empty:', e.message);
    return [];
  }
}

function isProUser(userId) {
  const idNum = Number(userId);
  const idStr = String(userId);
  return proUsers.includes(idNum) || proUsers.includes(idStr);
}

function ensureState(chatId) {
  const key = String(chatId);
  if (!stateByChat[key]) {
    stateByChat[key] = {
      mode: 'auto',            // auto | url | wallet | contract
      awaitingFeedback: false,
      awaitingTesterInfo: false,
      awaitingSupport: false
    };
  }
  return stateByChat[key];
}

function checkLimit(userId) {
  const id = String(userId);
  const today = getToday();

  if (isProUser(userId)) {
    return { isPro: true, allowed: true, remaining: null };
  }

  if (!usage[id] || usage[id].date !== today) {
    usage[id] = { date: today, count: 0 };
  }

  const max = config.maxFreeChecksPerDay;
  const current = usage[id].count;

  if (current >= max) {
    return { isPro: false, allowed: false, remaining: 0 };
  }

  const newCount = current + 1;
  usage[id].count = newCount;
  saveUsage();
  const remaining = max - newCount;

  return { isPro: false, allowed: true, remaining };
}

// ===== Keyboards =====

function mainReplyKeyboard() {
  return Markup.keyboard([
    ['🔗 URL', '👛 Wallet', '📜 Contract'],
    ['🤖 Auto-detect', '🆘 Support']
  ]).resize();
}

function resultKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('👍 All good', 'feedback_ok'),
      Markup.button.callback('⚠️ Dispute result', 'feedback_dispute')
    ]
  ]);
}

const bot = new Telegraf(config.botToken);

// ===== Commands =====

// /start
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  const state = ensureState(chatId);
  state.mode = 'auto';
  state.awaitingFeedback = false;
  state.awaitingTesterInfo = false;
  state.awaitingSupport = false;

  const text =
    'Hi! I am the Telegram bot for ScamScan (beta, for early testers).\n\n' +
    'Send me a URL, wallet address or contract address and I will call the ScamScan engine and return a risk assessment.\n\n' +
    'You can:\n' +
    '• Just paste what you want to check and let me auto-detect the type\n' +
    '• Or use the keyboard below to explicitly choose URL / wallet / contract.';

  return ctx.reply(text, mainReplyKeyboard());
});

// /help
bot.help((ctx) => {
  const text =
    'ScamScan bot:\n\n' +
    '1) Accepts URLs, wallet addresses and contract addresses\n' +
    '2) Detects the type (or uses the selected mode)\n' +
    '3) Calls https://scamscan.online/api/check\n' +
    '4) Returns risk level and a short explanation.\n\n' +
    'Commands:\n' +
    '/start  — restart bot and show main menu\n' +
    '/tester — apply for PRO tester (no daily limits)\n' +
    '/whoami — show your Telegram ID\n' +
    '/support — send a message to the ScamScan team.';
  return ctx.reply(text, mainReplyKeyboard());
});

// /tester — PRO application
bot.command('tester', (ctx) => {
  const chatId = ctx.chat.id;
  const state = ensureState(chatId);
  state.awaitingTesterInfo = true;
  state.awaitingFeedback = false;
  state.awaitingSupport = false;

  const text =
    'In one message, tell me how you plan to use ScamScan and why you need a PRO account.\n' +
    'I will log this as a tester application. PRO access is granted manually.';
  return ctx.reply(text);
});

// /whoami — show user ID
bot.command('whoami', (ctx) => {
  const u = ctx.from;
  const username = u.username ? '@' + u.username : '(no username)';
  const msg =
    'Your Telegram ID: `' + u.id + '`' +
    '\nUsername: ' + username;
  return ctx.reply(msg, { parse_mode: 'Markdown' });
});

// /support — user writes to team
bot.command('support', (ctx) => {
  const chatId = ctx.chat.id;
  const state = ensureState(chatId);
  state.awaitingSupport = true;
  state.awaitingFeedback = false;
  state.awaitingTesterInfo = false;

  const text =
    'Send one message describing your question or issue.\n' +
    'It will be forwarded to the ScamScan team.';
  return ctx.reply(text);
});

// /reply <chatId> <message> — admin replies from bot (запасной вариант)
bot.command('reply', async (ctx) => {
  const fromId = ctx.from.id;
  if (!ADMIN_IDS.includes(fromId)) {
    return ctx.reply('You are not allowed to use this command.');
  }

  const text = (ctx.message.text || '').trim();
  const parts = text.split(' ').slice(1); // skip "/reply"

  if (parts.length < 2) {
    return ctx.reply('Usage: /reply <chatId> <message>');
  }

  const targetChatId = parts[0];
  const replyText = parts.slice(1).join(' ');

  try {
    await ctx.telegram.sendMessage(targetChatId, replyText, { parse_mode: 'Markdown' });
    return ctx.reply('Reply sent.');
  } catch (err) {
    console.error('Failed to send reply:', err);
    return ctx.reply('Failed to send reply: ' + (err.message || 'unknown error'));
  }
});

// ===== Feedback buttons =====

bot.action('feedback_ok', (ctx) => {
  ctx.answerCbQuery('Thanks!').catch(() => {});
  return ctx.reply('Got it, thanks. If a result ever looks wrong, tap "Dispute result" and describe the issue.');
});

bot.action('feedback_dispute', (ctx) => {
  const chatId = ctx.chat.id;
  const state = ensureState(chatId);
  state.awaitingFeedback = true;
  state.awaitingTesterInfo = false;
  state.awaitingSupport = false;

  ctx.answerCbQuery('Waiting for your comment').catch(() => {});
  const text =
    'Send one message describing what looks wrong about this assessment (why you think it is incorrect).\n' +
    'I will log it as feedback to improve ScamScan.';
  return ctx.reply(text);
});

// ===== Main text handler =====

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const rawText = ctx.message.text || '';
  const text = rawText.trim();
  if (!text) return;

  const isAdmin = ADMIN_IDS.includes(userId);

  // 0) Admin reply via Telegram "Reply" на support-сообщение
  if (isAdmin && ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const originalText = ctx.message.reply_to_message.text;
    const match = originalText.match(/chatId:\s*(-?\d+)/);
    if (match && match[1]) {
      const targetChatId = match[1];
      try {
        await ctx.telegram.sendMessage(targetChatId, text, { parse_mode: 'Markdown' });
        return ctx.reply('Reply sent.');
      } catch (err) {
        console.error('Failed to send reply via reply-to:', err);
        return ctx.reply('Failed to send reply: ' + (err.message || 'unknown error'));
      }
    }
  }

  // команды уже обработаны своими handlers
  if (text.startsWith('/')) return;

  const state = ensureState(chatId);

  // 1) Support flow
  if (state.awaitingSupport) {
    state.awaitingSupport = false;

    logFeedback({
      chatId,
      username: ctx.from.username,
      input: null,
      inputType: 'support',
      apiResponse: null,
      feedbackText: text
    });

    const u = ctx.from;
    const username = u.username ? '@' + u.username : (u.first_name || 'user');
    const header =
      'Support message from ' + username +
      ' (id: ' + u.id + ', chatId: ' + chatId + '):';

    const body = header + '\n\n' + text;

    try {
      await Promise.all(
        ADMIN_IDS.map((adminId) =>
          ctx.telegram.sendMessage(adminId, body)
        )
      );
    } catch (err) {
      console.error('Failed to forward support message:', err);
    }

    return ctx.reply('Thanks, your message was sent to the ScamScan team.');
  }

  // 2) Feedback flow (dispute result)
  if (state.awaitingFeedback && lastCheckByChat[String(chatId)]) {
    state.awaitingFeedback = false;
    const last = lastCheckByChat[String(chatId)];

    logFeedback({
      chatId,
      username: ctx.from.username,
      input: last.input,
      inputType: last.type,
      apiResponse: last.apiResponse,
      feedbackText: text
    });

    return ctx.reply('Thanks, your feedback has been recorded. Real-world cases like this help improve ScamScan.');
  }

  // 3) Tester application flow
  if (state.awaitingTesterInfo) {
    state.awaitingTesterInfo = false;

    logFeedback({
      chatId,
      username: ctx.from.username,
      input: null,
      inputType: 'tester',
      apiResponse: null,
      feedbackText: text
    });

    return ctx.reply('Tester application saved. PRO access will be granted manually to active users.');
  }

  // 4) Quick mode switches via reply keyboard (включая Support)
  if (text === '🔗 URL' || text.toLowerCase() === 'url') {
    state.mode = 'url';
    state.awaitingFeedback = false;
    state.awaitingTesterInfo = false;
    state.awaitingSupport = false;
    return ctx.reply('Mode set to URL check. Send the link you want to scan.');
  }

  if (text === '👛 Wallet' || text.toLowerCase() === 'wallet') {
    state.mode = 'wallet';
    state.awaitingFeedback = false;
    state.awaitingTesterInfo = false;
    state.awaitingSupport = false;
    return ctx.reply('Mode set to wallet check. Send the wallet address.');
  }

  if (text === '📜 Contract' || text.toLowerCase() === 'contract') {
    state.mode = 'contract';
    state.awaitingFeedback = false;
    state.awaitingTesterInfo = false;
    state.awaitingSupport = false;
    return ctx.reply('Mode set to contract check (EVM). Send a contract address like 0x....');
  }

  if (text === '🤖 Auto-detect' || text.toLowerCase() === 'auto' || text.toLowerCase() === 'auto-detect') {
    state.mode = 'auto';
    state.awaitingFeedback = false;
    state.awaitingTesterInfo = false;
    state.awaitingSupport = false;
    return ctx.reply('Mode set to auto-detect. Send any URL, wallet or contract.');
  }

  if (text === '🆘 Support' || text.toLowerCase() === 'support') {
    state.awaitingSupport = true;
    state.awaitingFeedback = false;
    state.awaitingTesterInfo = false;
    return ctx.reply(
      'Send one message describing your question or issue.\n' +
      'It will be forwarded to the ScamScan team.'
    );
  }

  // 5) Normal check
  const mode = state.mode || 'auto';
  const forcedType = mode === 'auto' ? null : mode;
  const inputType = detectInputType(text, forcedType);

  const limitInfo = checkLimit(userId);
  if (!limitInfo.allowed) {
    return ctx.reply(
      'You have reached today\'s free check limit.\n\n' +
      'Active testers may get PRO access with no limits. Use /tester to send a short application.'
    );
  }

  try {
    await ctx.sendChatAction('typing');

    const apiResult = await checkValue(inputType, text);

    if (!apiResult.ok) {
      return ctx.reply(
        'Failed to get a response from the ScamScan API: ' +
        (apiResult.error || 'unknown error') +
        '\n\nTry again later or check directly on https://scamscan.online'
      );
    }

    lastCheckByChat[String(chatId)] = {
      input: text,
      type: inputType,
      apiResponse: apiResult.data
    };

    const message = formatCheckResult({
      type: inputType,
      input: text,
      data: apiResult.data,
      isPro: limitInfo.isPro,
      remaining: limitInfo.remaining,
      maxFree: config.maxFreeChecksPerDay
    });

    const kb = resultKeyboard();
    return ctx.reply(message, { parse_mode: 'Markdown', reply_markup: kb.reply_markup });
  } catch (err) {
    console.error('Unexpected bot error:', err);
    return ctx.reply('Service is temporarily unavailable or an internal error occurred. Please try again a bit later.');
  }
});

// ===== Launch bot =====

bot.launch()
  .then(() => console.log('ScamScan Telegram bot started'))
  .catch((err) => console.error('Failed to launch bot:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
