const axios = require('axios');
const { getPageContent } = require("./renderService");
const { detectType, detectChain } = require('../utils/domainUtils');
const { RPC_PROVIDERS } = require('../config/rpc');

// Program ID SPL Token
const SOLANA_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// HTML → текст
function stripHtmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  let text = html;

  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<[^>]+>/g, ' ');

  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, '\'');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');

  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

// Детект адресов в тексте
function extractWalletCandidates(text, maxCount = 20) {
  if (!text || typeof text !== 'string') return [];
  const candidates = new Set();
  let m;

  // EVM: 0x + 40 hex
  const evm = /0x[a-fA-F0-9]{40}/g;
  while ((m = evm.exec(text)) !== null) candidates.add(m[0]);

  // BTC: legacy + bech32
  const btc = /(bc1[a-zA-Z0-9]{25,39}|[13][a-zA-Z0-9]{25,39})/g;
  while ((m = btc.exec(text)) !== null) candidates.add(m[0]);

  // Tron
  const trx = /T[1-9A-HJ-NP-Za-km-z]{33}/g;
  while ((m = trx.exec(text)) !== null) candidates.add(m[0]);

  // Solana (base58, 32–44 символа)
  const sol = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  while ((m = sol.exec(text)) !== null) candidates.add(m[0]);

  // TON base64
  const tonb64 = /(EQ|UQ)[A-Za-z0-9_-]{46}/g;
  while ((m = tonb64.exec(text)) !== null) candidates.add(m[0]);

  // TON hex 0:xxxxxxxx
  const tonhex = /0:[0-9a-fA-F]{64}/g;
  while ((m = tonhex.exec(text)) !== null) candidates.add(m[0]);

  const list = Array.from(candidates);

  // Убираем мусор: строки, которые просто являются подстрокой других адресов
  const filtered = list.filter(function (addr) {
    return !list.some(function (other) {
      return other.length > addr.length && other.indexOf(addr) !== -1;
    });
  });

  return filtered.slice(0, maxCount);
}

// JSON-RPC helper для EVM
async function jsonRpcCall(chain, method, params) {
  const urls = (RPC_PROVIDERS[chain] || []).filter(Boolean);
  for (const url of urls) {
    try {
      const resp = await axios.post(
        url,
        { jsonrpc: '2.0', id: 1, method, params },
        {
          timeout: 5000,
          headers: { 'Content-Type': 'application/json' }
        }
      );
      if (resp.data && !resp.data.error) {
        return resp.data.result;
      }
    } catch (e) {
      console.log(`[Content] RPC ${chain} ${method} failed on ${url}: ${e.message}`);
    }
  }
  throw new Error(`RPC_${chain}_FAILED`);
}

// Solana RPC helper
async function solanaRpcCall(method, params) {
  const url = process.env.SOLANA_RPC_URL;
  if (!url) throw new Error('SOLANA_RPC_URL not configured');

  const resp = await axios.post(
    url,
    { jsonrpc: '2.0', id: 1, method, params },
    {
      timeout: 7000,
      headers: { 'Content-Type': 'application/json' }
    }
  );

  if (!resp.data || resp.data.error) {
    throw new Error(
      resp.data && resp.data.error ? resp.data.error.message : 'Solana RPC error'
    );
  }

  return resp.data.result;
}

// Лёгкий детектор для Solana: program / mint / token-account / wallet
async function detectSolanaAddressInfo(address) {
  try {
    const result = await solanaRpcCall('getAccountInfo', [
      address,
      { encoding: 'jsonParsed' }
    ]);

    const value = result && result.value;
    if (!value) return null;

    const executable = !!value.executable;
    const owner = value.owner || null;
    const dataParsed =
      value.data && typeof value.data === 'object' && value.data.parsed
        ? value.data.parsed
        : null;

    let detectedType = 'wallet';
    let detectedChain = 'solana-like';
    let solanaEntityType = 'wallet';

    // Программа (смарт-контракт)
    if (executable) {
      detectedType = 'contract';
      solanaEntityType = 'program';
    } else if (owner === SOLANA_TOKEN_PROGRAM_ID) {
      // SPL Token: mint / token-account
      if (dataParsed && dataParsed.type === 'mint') {
        detectedType = 'token';
        solanaEntityType = 'mint';
      } else if (dataParsed && dataParsed.type === 'account') {
        detectedType = 'token-account';
        solanaEntityType = 'token-account';
      } else {
        // На всякий случай, если token program, но тип не распознан
        detectedType = 'token-account';
        solanaEntityType = 'token-account';
      }
    } else {
      // Обычный аккаунт Solana
      detectedType = 'wallet';
      solanaEntityType = 'wallet';
    }

    return {
      detectedType,
      detectedChain,
      solanaEntityType
    };
  } catch (e) {
    console.log(`[Content] Solana type detection failed for ${address}: ${e.message}`);
    return null;
  }
}

// Лёгкий детектор EVM: кошелёк / контракт / сеть
async function detectEvmAddressInfo(address, preferredChain) {
  const baseChains = ['ethereum', 'bsc'];

  const chainsToTry =
    preferredChain && baseChains.includes(preferredChain)
      ? [preferredChain, ...baseChains.filter((c) => c !== preferredChain)]
      : baseChains;

  const results = [];

  for (const chain of chainsToTry) {
    try {
      const code = await jsonRpcCall(chain, 'eth_getCode', [address, 'latest']);
      if (typeof code === 'string') {
        results.push({ chain, code });
      }
    } catch (e) {
      // идём дальше
    }
  }

  if (!results.length) return null;

  const contractEntry = results.find((r) => r.code !== '0x' && r.code !== '0x0');
  if (contractEntry) {
    return { detectedType: 'contract', detectedChain: contractEntry.chain };
  }

  const walletEntry = results.find((r) => r.code === '0x' || r.code === '0x0');
  if (walletEntry) {
    return { detectedType: 'wallet', detectedChain: walletEntry.chain };
  }

  return null;
}

// Контентный скоринг: фразы → оценки
function evaluateTextRisk(text) {
  const lower = (text || '').toLowerCase();
  const matchesSet = new Set();
  let score = 0;

  let hasInvestmentBuzz = false;
  let hasYieldPromise = false;
  let hasReferral = false;

  const soft = [
    'giveaway',
    'airdrop',
    'connect wallet',
    'claim reward',
    'validate wallet',
    'synchronize',
    'official promotion',
    'support team'
  ];

  const investmentBuzz = [
    'investment platform',
    'trading platform',
    'trading bot',
    'forex',
    'forex trading',
    'copy trading',
    'signal group',
    'crypto investment',
    'investment plan',
    'investment package'
  ];

  const yieldPromises = [
    'passive income',
    'stable income',
    'guaranteed',
    'guaranteed profit',
    'fixed income',
    'fixed return',
    'daily profit',
    'monthly profit',
    '% per day',
    '% daily',
    'per day roi',
    'return on investment',
    'high roi',
    'double your money',
    '2x your',
    '3x your'
  ];

  const referralStuff = [
    'referral program',
    'affiliate program',
    'multi level marketing',
    'multi-level marketing',
    'mlm',
    'invite friends and earn'
  ];

  const hitGroup = (list, addScore, flagFn) => {
    list.forEach((phrase) => {
      if (lower.includes(phrase)) {
        matchesSet.add(phrase);
        score += addScore;
        if (flagFn) flagFn();
      }
    });
  };

  hitGroup(soft, 5, null);
  hitGroup(investmentBuzz, 15, () => {
    hasInvestmentBuzz = true;
  });
  hitGroup(yieldPromises, 20, () => {
    hasYieldPromise = true;
  });
  hitGroup(referralStuff, 15, () => {
    hasReferral = true;
  });

  // Комбинации паттернов
  if (hasInvestmentBuzz && hasYieldPromise) {
    score = Math.max(score, 60);
  }

  if (hasInvestmentBuzz && hasYieldPromise && hasReferral) {
    score = Math.max(score, 70);
  }

  if (score > 80) score = 80;

  return {
    score,
    matches: Array.from(matchesSet),
    flags: {
      hasInvestmentBuzz,
      hasYieldPromise,
      hasReferral
    }
  };
}

// Попытка скачать через axios
async function fetchPageViaAxios(url) {
  const resp = await axios.get(url, {
    timeout: 7000,
    maxRedirects: 3,
    headers: { 'User-Agent': 'Mozilla/5.0 ScamScanBot/1.0' }
  });

  const ct = resp.headers['content-type'] || '';
  if (!/text\/html|application\/xhtml\+xml/i.test(ct)) {
    throw new Error('NON_HTML_CONTENT');
  }

  return resp.data;
}

// Главная функция анализа контента сайта
async function analyzeWebsiteContent(domain) {
  const url = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;

  let html = '';
  let text = '';
  let source = 'axios';

  console.log(`[Content] Starting analysis for ${url}...`);

  // Путь 1 — axios
  try {
    html = await fetchPageViaAxios(url);
    text = stripHtmlToText(html);

    const hasSpaRoot = /<div[^>]+id="(?:root|app)"[^>]*>/i.test(html);
    const hasChunks =
      /chunk|webpack|vite|react|vue/i.test(html) ||
      /<script[^>]+chunk[^>]*><\/script>/i.test(html);

    if (hasSpaRoot && hasChunks) {
      console.log('[Content] SPA detected, switching to Puppeteer...');
      throw new Error('SPA_DETECTED');
    }
  } catch (e) {
    // Путь 2 — Puppeteer
    console.log(`[Content] Axios failed: ${e.message} → Puppeteer fallback`);
    try {
      const p = await getPageContent(url);
      if (!p || !p.html) throw new Error('EMPTY_RENDER');
      html = p.html;
      text = p.text || stripHtmlToText(p.html);
      source = 'puppeteer';
    } catch (err) {
      console.log('[Content] Puppeteer failed:', err.message);
      return {
        score: 0,
        matches: [],
        source: 'failed',
        wallets: [],
        rawWallets: [],
        walletWarnings: ['Unable to fetch site content for analysis.']
      };
    }
  }

  // 1) Контентный анализ текста
  const textEval = evaluateTextRisk(text);
  let riskScore = textEval.score;
  const matches = textEval.matches;
  const flags = textEval.flags;

  // 2) Поиск адресов
  const rawWallets = extractWalletCandidates(text);
  const wallets = [];
  const walletWarnings = [];

  let hasEvmOrBscContract = false;

  for (const address of rawWallets) {
    let detectedType = 'unknown';
    let detectedChain = 'unknown';
    let solanaEntityType = null;

    try {
      detectedType = detectType(address) || 'unknown';
      detectedChain = detectChain(address) || 'unknown';
    } catch (e) {
      // пофиг
    }

    // Уточняем EVM-адреса через RPC
    if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
      try {
        const info = await detectEvmAddressInfo(address, detectedChain);
        if (info) {
          if (info.detectedType) detectedType = info.detectedType;
          if (info.detectedChain) detectedChain = info.detectedChain;
        }
      } catch (e) {
        console.log(`[Content] EVM type detection failed for ${address}: ${e.message}`);
      }
    }
    // Уточняем Solana-адреса через RPC
    else if (detectedChain === 'solana-like') {
      try {
        const info = await detectSolanaAddressInfo(address);
        if (info) {
          if (info.detectedType) detectedType = info.detectedType;
          if (info.detectedChain) detectedChain = info.detectedChain;
          if (info.solanaEntityType) solanaEntityType = info.solanaEntityType;
        }
      } catch (e) {
        // ошибка уже залогана внутри detectSolanaAddressInfo
      }
    }

    if (
      detectedType === 'contract' &&
      (detectedChain === 'ethereum' || detectedChain === 'bsc')
    ) {
      hasEvmOrBscContract = true;
    }

    const walletEntry = {
      address,
      detectedType,
      detectedChain
    };
    if (solanaEntityType) {
      walletEntry.solanaEntityType = solanaEntityType;
    }

    wallets.push(walletEntry);
  }

  if (rawWallets.length > 0) {
    walletWarnings.push(
      'Displaying crypto addresses on a website is a common scam indicator.'
    );
    riskScore += 5; // лёгкий бонус за то, что деньги фигурируют
  }

  // 3) Усиление риска для типичных "инвест-лендингов" с контрактами
  if (hasEvmOrBscContract && flags.hasInvestmentBuzz && flags.hasYieldPromise) {
    riskScore = Math.max(riskScore, 80); // SCAM уровень
  } else if (flags.hasInvestmentBuzz && flags.hasYieldPromise) {
    riskScore = Math.max(riskScore, 60); // минимум SUSPICIOUS
  }

  if (riskScore > 80) riskScore = 80;

  return {
    score: riskScore,
    matches,
    source,
    wallets,
    rawWallets,
    walletWarnings
  };
}

module.exports = { analyzeWebsiteContent };
