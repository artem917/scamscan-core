
require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');

// --- Базовые настройки ---

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан в .env');
  process.exit(1);
}

// OpenAI: подключаем библиотеку, если она установлена
let OpenAI;
try {
  OpenAI = require('openai');
} catch (e) {
  console.error('❌ Модуль "openai" не найден. В папке бота нужно выполнить: npm install openai');
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

let openai = null;
if (OpenAI && OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
} else {
  console.warn('⚠️ OpenAI пока не инициализирован. Либо нет API‑ключа, либо не установлен модуль "openai".');
}

const bot = new Telegraf(BOT_TOKEN);

// --- Админы ---

const ADMINS = new Set([
  373229100, // Артём
  346722278  // Костя
]);

function isAdmin(ctx) {
  return ctx.from && ADMINS.has(ctx.from.id);
}

// --- Память по нишам (в оперативке) ---

const userNiches = new Map();

const NICHES = {
  relationships: 'отношения',
  money: 'деньги',
  psychology: 'психология',
  other: 'другая ниша'
};

function getNicheLabel(key) {
  return NICHES[key] || 'не выбрана';
}

function getUserNicheKey(userId) {
  return userNiches.get(userId) || 'other';
}

// --- Клавиатуры ---

const mainKeyboard = Markup.keyboard([
  ['🧩 Разобрать ролик', '🧠 Сменить нишу'],
  ['❓ Помощь']
]).resize();

const nicheKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback('Отношения', 'niche_relationships'),
    Markup.button.callback('Деньги', 'niche_money')
  ],
  [
    Markup.button.callback('Психология', 'niche_psychology'),
    Markup.button.callback('Другая ниша', 'niche_other')
  ]
]);

// --- /start ---

bot.start((ctx) => {
  const userId = ctx.from.id;
  const nicheKey = getUserNicheKey(userId);
  const nicheLabel = getNicheLabel(nicheKey);

  ctx.reply(
    'Привет! Я Парсер смыслов (лайт‑версия).\n\n' +
    'Сейчас я в стадии настройки. Разбираю ролики и помогаю находить дефицитные заголовки и сценарии под твою нишу.\n\n' +
    `Текущая ниша: ${nicheLabel}.\n` +
    'Командой /set_niche или кнопкой 🧠 «Сменить нишу» можно выбрать нишу, с которой ты сейчас работаешь.\n\n' +
    'Присылай ссылку на ролик или текст — попробую разобрать смыслы и предложить варианты заголовков.',
    mainKeyboard
  );
});

// --- /help ---

bot.help((ctx) => {
  const userId = ctx.from.id;
  const nicheKey = getUserNicheKey(userId);
  const nicheLabel = getNicheLabel(nicheKey);

  ctx.reply(
    'Как работает Лайт‑версия:\n\n' +
    '1) Ты задаёшь нишу командой /set_niche (отношения, деньги, психология и т.д.).\n' +
    '2) Присылаешь ссылку на ролик или текстовое описание.\n' +
    '3) Бот обращается к ИИ: вытаскивает дефицитные смыслы и предлагает заголовки и сценарии.\n\n' +
    `Текущая ниша: ${nicheLabel}.\n\n` +
    'Кнопки внизу:\n' +
    '• 🧩 «Разобрать ролик» — напоминание, что нужно прислать ссылку или текст.\n' +
    '• 🧠 «Сменить нишу» — выбор ниши.\n' +
    '• ❓ «Помощь» — это сообщение.'
  );
});

// --- /set_niche ---

bot.command('set_niche', (ctx) => {
  ctx.reply('Выбери нишу, с которой сейчас работаешь:', nicheKeyboard);
});

bot.action(/^niche_(.+)$/, (ctx) => {
  const key = ctx.match[1]; // relationships / money / psychology / other
  const userId = ctx.from.id;

  userNiches.set(userId, key);
  const label = getNicheLabel(key);

  ctx.answerCbQuery(`Ниша обновлена: ${label}`);
  ctx.editMessageText(
    `Ниша обновлена: ${label}.\n\nТеперь пришли ссылку на ролик или его текстовое описание — я разберу смыслы и предложу варианты заголовков.`
  );
});

// --- Кнопки внизу ---

bot.hears('🧩 Разобрать ролик', (ctx) => {
  ctx.reply(
    'Пришли ссылку на ролик (Reels/Shorts/TikTok и т.п.) или текстовое описание. ' +
    'Я вытащу ключевые смыслы и предложу варианты заголовков и сценариев.'
  );
});

bot.hears('🧠 Сменить нишу', (ctx) => {
  ctx.reply('Ок, выбери нишу:', nicheKeyboard);
});

bot.hears('❓ Помощь', (ctx) => {
  bot.help(ctx);
});

// --- Админ‑команды ---

bot.command('admin', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('Эта команда только для админов.');
  }

  ctx.reply(
    'Админ‑панель (черновик):\n' +
    '• /stats — простая статистика по нишам (по текущему процессу).\n' +
    '• /test_ai — тестовый запрос к OpenAI.\n'
  );
});

bot.command('stats', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply(`Сохранённых ниш в памяти процесса: ${userNiches.size} пользовател(ей/я).`);
});

bot.command('test_ai', async (ctx) => {
  if (!isAdmin(ctx)) return;

  if (!openai) {
    return ctx.reply('OpenAI пока не настроен. Проверь .env и модуль "openai".');
  }

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'developer', content: 'Ты кратко отвечающий маркетолог по коротким видео.' },
        { role: 'user', content: 'Дай один пример дефицитного заголовка для ролика про деньги.' }
      ],
      temperature: 0.7
    });

    const text = completion.choices[0]?.message?.content?.trim() || 'Пустой ответ от модели.';
    await ctx.reply('Тестовый ответ ИИ:\n\n' + text);
  } catch (err) {
    console.error('Ошибка test_ai:', err);
    await ctx.reply('Не удалось сходить в OpenAI. Смотри логи и баланс в кабинете.');
  }
});

// --- Основной обработчик текста ---

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();

  // Игнорируем команды
  if (text.startsWith('/')) return;

  if (!openai) {
    return ctx.reply('ИИ ещё не подключён. Нужен рабочий OPENAI_API_KEY и установленный модуль "openai".');
  }

  const userId = ctx.from.id;
  const nicheKey = getUserNicheKey(userId);
  const nicheLabel = getNicheLabel(nicheKey);

  const isUrl = /^https?:\/\//i.test(text);

  const intro =
    'Окей, беру в работу.\n' +
    `Текущая ниша: ${nicheLabel}.\n` +
    (isUrl
      ? 'Ты прислал ссылку — воспринимаю её как ролик по этой нише.\n'
      : 'Ты прислал текст — воспринимаю его как идею/черновик ролика.\n');

  await ctx.reply(intro);

  try {
    const systemPrompt =
      'Ты опытный маркетолог коротких вертикальных видео (Reels/Shorts/TikTok). ' +
      'Твоя задача — из входного текста или описания ролика вытащить дефицитные смыслы и упаковать их в заголовки и сценарии. ' +
      'Отвечай на русском языке, кратко и по делу, без воды.';

    const userPrompt =
      `Ниша: ${nicheLabel}.\n\n` +
      'Текст, ссылка или описание ролика:\n' +
      text +
      '\n\n' +
      'Сделай структурированный разбор в таком формате:\n' +
      '1. Ключевые дефицитные смыслы (3–7 пунктов).\n' +
      '2. Варианты заголовков для ролика (5–10 штук).\n' +
      '3. Крючки для первых 3 секунд (3–7 очень коротких фраз).\n' +
      '4. 2–3 коротких сценария ролика (по шагам).\n' +
      'Без вступлений и заключений — сразу списки по пунктам.';

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'developer', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.9
    });

    const answer =
      completion.choices[0]?.message?.content?.trim() ||
      'Не удалось разобрать ответ модели.';

    const chunks = splitText(answer, 3500);
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('Ошибка при разборе текста через ИИ:', err);
    await ctx.reply(
      'Не смог подключиться к ИИ или произошла ошибка. Попробуй ещё раз позже. ' +
      'Если часто повторяется — смотри логи и баланс в OpenAI.'
    );
  }
});

// --- Вспомогательная функция нарезки ответа на части ---

function splitText(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const parts = [];
  let current = '';

  const lines = text.split('\n');
  for (const line of lines) {
    if ((current + '\n' + line).length > maxLength) {
      parts.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// --- Запуск ---

bot.launch().then(() => {
  console.log('✅ Meaning-parser-bot запущен');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
