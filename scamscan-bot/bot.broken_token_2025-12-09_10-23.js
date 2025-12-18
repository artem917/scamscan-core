const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const http = require('http');
const config = require('./config');
const { checkValue } = require('./services/apiClient');

// ===== Load & persist per-user settings (mode: url / wallet / contract / auto) =====

const USER_STATE_FILE = './user_state.json';

function loadUserState() {
    try {
        const data = fs.readFileSync(USER_STATE_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return {};
    }
}

function saveUserState(state) {
    try {
        fs.writeFileSync(USER_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save user_state.json:', err.message);
    }
}

/**
 * Загруженное состояние:
 * {
 *   "<telegramUserId>": {
 *       "mode": "auto" | "url" | "wallet" | "contract"
 *   },
 *   ...
 * }
 */
const userState = loadUserState();

/**
 * Возвращает режим пользователя.
 * По умолчанию — "auto".
 */
function getUserMode(userId) {
    const s = userState[String(userId)];
    if (!s || !s.mode) return 'auto';
    return s.mode;
}

/**
 * Сохранить режим пользователя и записать на диск.
 */
function setUserMode(userId, mode) {
    userState[String(userId)] = { mode };
    saveUserState(userState);
}

// ===== Bot init =====

const bot = new Telegraf(config.BOT_TOKEN);

const ADMINS = new Set(config.ADMINS || []);

function ensureAdmin(ctx) {
    if (!ctx.from || !ADMINS.has(ctx.from.id)) {
        return false;
    }
    return true;
}

function isProUser(ctx) {
    if (!ctx || !ctx.from) return false;
    return ADMINS.has(ctx.from.id) || (config.PRO_USERS && config.PRO_USERS.includes(ctx.from.id));
}

// ===== Helpers: reply formatting =====

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatResultMessage(result) {
    if (!result) return 'Unexpected empty response from API 🤔';

    let msg = '';

    msg += `<b>Type:</b> ${escapeHtml(result.type || 'unknown')}\n`;
    msg += `<b>Input:</b> ${escapeHtml(result.input || '')}\n`;
    msg += `<b>Verdict:</b> <b>${escapeHtml(result.verdict || 'UNKNOWN')}</b>\n`;

    if (typeof result.riskScore === 'number') {
        msg += `<b>Risk score:</b> ${result.riskScore} / 100\n`;
    }

    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
        msg += '\n<b>Warnings:</b>\n';
        for (const w of result.warnings) {
            msg += `• ${escapeHtml(w)}\n`;
        }
    }

    if (result.details && result.details.whitelist && result.details.whitelist.domain) {
        msg += `\n<b>Whitelisted:</b> ${escapeHtml(result.details.whitelist.domain)} (trusted source)\n`;
    }

    return msg.trim();
}

function getMainKeyboard(userId) {
    const mode = getUserMode(userId);

    const urlLabel = mode === 'url'     ? '✅ URL'     : 'URL';
    const walletLabel = mode === 'wallet' ? '✅ Wallet' : 'Wallet';
    const contractLabel = mode === 'contract' ? '✅ Contract' : 'Contract';
    const autoLabel = mode === 'auto' ? '✅ Auto-detect' : 'Auto-detect';

    return Markup.keyboard([
        [urlLabel, walletLabel, contractLabel],
        [autoLabel],
        ['📊 Admin']
    ]).resize();
}

// ===== Command handlers =====

bot.start(async (ctx) => {
    const uid = ctx.from.id;
    const firstName = ctx.from.first_name || 'there';

    if (!userState[String(uid)]) {
        setUserMode(uid, 'auto');
    }

    const mode = getUserMode(uid);

    let text = `Hi, ${escapeHtml(firstName)}! 👋\n\n`;
    text += `I'm ScamScan Bot. Paste a URL, wallet, or contract address, `;
    text += `and I'll check it for potential scam patterns based on the current rules.\n\n`;
    text += `Current mode: <b>${mode}</b>\n`;
    text += `Use the keyboard below to switch between URL / wallet / contract or stay in auto-detect mode.`;

    await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: getMainKeyboard(uid).reply_markup
    });
});

bot.help(async (ctx) => {
    const uid = ctx.from.id;
    const mode = getUserMode(uid);

    let text = '🤖 <b>ScamScan Bot Help</b>\n\n';
    text += 'I can check:\n';
    text += '• URLs (landing pages / investment offers / etc.)\n';
    text += '• Wallet addresses (supported chains only)\n';
    text += '• Smart-contract addresses (EVM chains)\n\n';
    text += 'Current mode: <b>' + escapeHtml(mode) + '</b>\n\n';
    text += 'Just send me what you want to check.\n';
    text += 'Use the keyboard buttons to change the mode.\n';

    if (ensureAdmin(ctx)) {
        text += '\n<b>Admin panel:</b> press "Admin" at the bottom or use /admin.\n';
    }

    await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: getMainKeyboard(uid).reply_markup
    });
});

// ===== Mode change via text keyboard =====

bot.hears('URL', async (ctx) => {
    const uid = ctx.from.id;
    setUserMode(uid, 'url');
    await ctx.reply('Mode switched to: URL 🔗', {
        reply_markup: getMainKeyboard(uid).reply_markup
    });
});

bot.hears('Wallet', async (ctx) => {
    const uid = ctx.from.id;
    setUserMode(uid, 'wallet');
    await ctx.reply('Mode switched to: Wallet 👛', {
        reply_markup: getMainKeyboard(uid).reply_markup
    });
});

bot.hears('Contract', async (ctx) => {
    const uid = ctx.from.id;
    setUserMode(uid, 'contract');
    await ctx.reply('Mode switched to: Contract 📜', {
        reply_markup: getMainKeyboard(uid).reply_markup
    });
});

bot.hears('Auto-detect', async (ctx) => {
    const uid = ctx.from.id;
    setUserMode(uid, 'auto');
    await ctx.reply('Mode switched to: Auto-detect 🤖', {
        reply_markup: getMainKeyboard(uid).reply_markup
    });
});

// ===== Admin keyboard entry point =====

bot.hears('📊 Admin', async (ctx) => {
    if (!ensureAdmin(ctx)) return;

    await sendAdminPanel(ctx);
});

async function sendAdminPanel(ctx) {
    const totalUsers = await getTotalUsersCount();
    const proUsers = await getProUsersCount();
    const checksToday = await getChecksTodayCount();

    let text = '📊 <b>ScamScan Stats:</b>\n';
    text += `• Users total: <b>${totalUsers}</b>\n`;
    text += `• PRO users: <b>${proUsers}</b>\n`;
    text += `• Checks today: <b>${checksToday}</b>\n\n`;

    text += '🛠 <b>Admin Panel Commands:</b>\n';
    text += '/stats — Show bot statistics\n';
    text += '/prolist — List all PRO users\n';
    text += '/setpro ID — Grant PRO status\n';
    text += '/unsetpro ID — Revoke PRO status\n';
    text += '/resetlimit ID — Reset daily limit\n';
    text += '/reply ID text — Manual reply without button\n';
    text += '/apihealth — Show API /health status (admin only)\n';

    await ctx.reply(text, {
        parse_mode: 'HTML'
    });
}

// ===== Dummy stubs for user statistics (replace with real DB later) =====

async function getTotalUsersCount() {
    return 4;
}

async function getProUsersCount() {
    return 1;
}

async function getChecksTodayCount() {
    return 1;
}

// ===== Main message handler =====

bot.on('text', async (ctx, next) => {
    const text = (ctx.message && ctx.message.text || '').trim();

    if (text.startsWith('/')) {
        return next();
    }

    const uid = ctx.from.id;
    const mode = getUserMode(uid);

    try {
        let type = mode;
        if (mode === 'auto') {
            if (/^https?:\/\//i.test(text)) {
                type = 'url';
            } else if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
                type = 'contract';
            } else {
                type = 'wallet';
            }
        }

        await ctx.reply('⏳ Checking ' + type.toUpperCase() + '...', {
            reply_markup: getMainKeyboard(uid).reply_markup
        });

        const result = await checkValue(text, type, { pro: isProUser(ctx) });

        const reply = formatResultMessage(result);

        await ctx.reply(reply, {
            parse_mode: 'HTML',
            reply_markup: getMainKeyboard(uid).reply_markup
        });
    } catch (err) {
        console.error('Error in text handler:', err);
        await ctx.reply('❌ Something went wrong while checking this value.', {
            reply_markup: getMainKeyboard(uid).reply_markup
        });
    }
});

// ===== Admin commands =====

bot.command('admin', async (ctx) => {
    if (!ensureAdmin(ctx)) return;
    await sendAdminPanel(ctx);
});

bot.command('stats', async (ctx) => {
    if (!ensureAdmin(ctx)) return;
    await sendAdminPanel(ctx);
});

bot.command('prolist', async (ctx) => {
    if (!ensureAdmin(ctx)) return;
    await ctx.reply('PRO users list is not implemented yet.', { parse_mode: 'HTML' });
});

bot.command('setpro', async (ctx) => {
    if (!ensureAdmin(ctx)) return;
    await ctx.reply('setpro is not implemented yet.', { parse_mode: 'HTML' });
});

bot.command('unsetpro', async (ctx) => {
    if (!ensureAdmin(ctx)) return;
    await ctx.reply('unsetpro is not implemented yet.', { parse_mode: 'HTML' });
});

bot.command('resetlimit', async (ctx) => {
    if (!ensureAdmin(ctx)) return;
    await ctx.reply('resetlimit is not implemented yet.', { parse_mode: 'HTML' });
});

bot.command('reply', async (ctx) => {
    if (!ensureAdmin(ctx)) return;
    await ctx.reply('manual reply is not implemented yet.', { parse_mode: 'HTML' });
});

// ===== Admin: API health =====
async function fetchApiHealth() {
    return new Promise((resolve, reject) => {
        const url = 'http://localhost:3000/api/health';
        http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json);
                } catch (e) {
                    reject(new Error('Cannot parse /api/health JSON: ' + e.message));
                }
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

async function formatApiHealthSimple() {
    try {
        const h = await fetchApiHealth();
        const status = (h && h.status) ? h.status : 'unknown';
        const uptimeSec = (h && typeof h.uptimeSec === 'number') ? h.uptimeSec : 0;
        const errors = (h && h.errors) ? h.errors : {};
        const totalRequests = (typeof errors.totalRequests === 'number') ? errors.totalRequests : null;
        const totalErrors = (typeof errors.totalErrors === 'number') ? errors.totalErrors : null;

        let msg = 'API health: status=' + status + ', uptime=' + uptimeSec + 's';
        if (totalRequests !== null) {
            msg += ', requests=' + totalRequests + ', errors=' + totalErrors;
        }
        return msg;
    } catch (err) {
        return 'API health error: ' + err.message;
    }
}

bot.command('apihealth', async (ctx) => {
    if (!ensureAdmin(ctx)) return;
    const msg = await formatApiHealthSimple();
    await ctx.reply(msg);
});

// ===== Launch =====

bot.launch().then(() => {
    console.log('ScamScan Telegram bot started');
}).catch((err) => {
    console.error('Failed to launch bot:', err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
