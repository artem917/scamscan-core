
// SCAMSCAN_CF_FORCE_PUPPETEER_V3
function _looksLikeCloudflare(html) {
  const h = String(html || "").toLowerCase();
  return (
    h.includes("/cdn-cgi/") ||
    (h.includes("cloudflare") && (h.includes("attention required") || h.includes("verify you are human") || h.includes("checking your browser")))
  );
}

/* SC_CONTENT_DEBUG_META_V2 */
function _blockedHintFromHtml(html, text) {
  const h = String(html || "").toLowerCase();
  const t = String(text || "").toLowerCase();
  const blob = (h + "\n" + t);
  if (!blob.trim()) return null;

  if (blob.includes("recaptcha") || blob.includes("g-recaptcha") || blob.includes("hcaptcha")) return "captcha";
  if (blob.includes("attention required") && blob.includes("cloudflare")) return "cloudflare_challenge";
  if (blob.includes("/cdn-cgi/") && (blob.includes("challenge") || blob.includes("cf-challenge"))) return "cloudflare_challenge";
  if (blob.includes("verify you are human") || blob.includes("bot detection") || blob.includes("i am not a robot")) return "bot_challenge";
  if (blob.includes("access denied") || blob.includes("forbidden") || blob.includes("request blocked")) return "access_denied";
  if (blob.includes("enable javascript") && blob.includes("cookies")) return "js_cookies_required";
  return null;
}

function _classifyFetchFailure(errA, errB) {
  const msg = [errA, errB]
    .map((e) => String((e && (e.message || e.code)) || '').toLowerCase().trim())
    .filter(Boolean)
    .join(' | ');

  if (!msg) {
    return {
      source: 'failed',
      warning: 'Unable to fetch site content for analysis.',
      reason: 'unknown_fetch_failure'
    };
  }

  if (msg.includes('cert') || msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls')) {
    return {
      source: 'failed_tls',
      warning: 'Site TLS or certificate errors prevented content fetch. Content-based verdict is unavailable.',
      reason: 'tls_or_certificate_error'
    };
  }

  if (msg.includes('captcha') || msg.includes('challenge') || msg.includes('access denied') || msg.includes('blocked')) {
    return {
      source: 'failed_blocked',
      warning: 'Site access controls prevented content fetch. Content-based verdict is unavailable.',
      reason: 'blocked_or_challenged'
    };
  }

  if (msg.includes('timeout') || msg.includes('timed out')) {
    return {
      source: 'failed_timeout',
      warning: 'Timed out while fetching site content. Content-based verdict is unavailable.',
      reason: 'timeout'
    };
  }

  return {
    source: 'failed',
    warning: 'Unable to fetch site content for analysis.',
    reason: 'unknown_fetch_failure'
  };
}

function _blockedByFromReason(reason) {
  const raw = String(reason || '').toLowerCase().trim();
  if (!raw) return null;
  if (raw.includes('captcha')) return 'captcha';
  if (raw.includes('cloudflare')) return 'cloudflare_challenge';
  if (raw.includes('bot_challenge') || raw.includes('bot challenge')) return 'bot_challenge';
  if (raw.includes('access_denied') || raw.includes('access denied') || raw.includes('forbidden')) return 'access_denied';
  if (raw.includes('js_cookies_required') || raw.includes('javascript') || raw.includes('cookies')) return 'js_cookies_required';
  if (raw.includes('tls') || raw.includes('certificate') || raw.includes('ssl')) return 'tls_or_certificate_error';
  if (raw.includes('timeout')) return 'timeout';
  if (raw.includes('blocked') || raw.includes('challenge')) return 'blocked_or_challenged';
  return null;
}

const axios = require('axios');
const https = require('https');
const { getPageContent } = require("./renderService");
const { detectType, detectChain } = require('../utils/domainUtils');
const { RPC_PROVIDERS } = require('../config/rpc');

// Program ID SPL Token
const SOLANA_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// HTML в†’ С‚РµРєСЃС‚
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

function _normalizeTextLines(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function _dedupeBoilerplateLines(lines, maxRepeat = 1) {
  const seen = new Map();
  const out = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const key = String(line || '').toLowerCase();
    if (!key) continue;
    const nextCount = (seen.get(key) || 0) + 1;
    seen.set(key, nextCount);
    if (nextCount <= maxRepeat) out.push(line);
  }
  return out;
}

function _extractPreferredTextFromHtml(html) {
  if (!html || typeof html !== 'string') return '';

  const base = String(html || '');
  const narrowed = base
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form|button)[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  const candidates = [];
  const blockRe = /<(article|main|section)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = blockRe.exec(narrowed)) !== null) {
    const blockHtml = String(m[2] || '');
    const blockText = stripHtmlToText(blockHtml);
    if (blockText && blockText.length >= 180) candidates.push(blockText);
  }

  let sourceText = '';
  if (candidates.length) {
    candidates.sort((a, b) => b.length - a.length);
    sourceText = candidates.slice(0, 3).join('\n');
  } else {
    sourceText = stripHtmlToText(narrowed);
  }

  const cleanedLines = _dedupeBoilerplateLines(
    _normalizeTextLines(sourceText).filter((line) => {
      const lower = line.toLowerCase();
      if (line.length <= 2) return false;
      if (lower === 'menu' || lower === 'close') return false;
      if (/^(login|logout|sign in|sign up|connect wallet|link wallet)$/i.test(line)) return false;
      if (/^(telegram|walletconnect|metamask)$/i.test(line)) return false;
      return true;
    }),
    1
  );

  return cleanedLines.join('\n').trim();
}

// Р”РµС‚РµРєС‚ Р°РґСЂРµСЃРѕРІ РІ С‚РµРєСЃС‚Рµ
function extractWalletCandidates(text, maxCount = 20, options = {}) {
  if (!text || typeof text !== 'string') return [];
  const opts = Object.assign({
    allowBase58Like: true
  }, options || {});
  const candidates = new Set();
  let m;

  function _isWordish(ch) {
    return !!ch && /[A-Za-z0-9_-]/.test(ch);
  }

  function _hasLooseBoundary(src, start, end) {
    const prev = start > 0 ? src[start - 1] : '';
    const next = end < src.length ? src[end] : '';
    return !_isWordish(prev) && !_isWordish(next);
  }

  function _looksHexLikeNoise(value) {
    const v = String(value || '').trim();
    if (!v) return true;
    if (/^[0-9a-fA-F]{24,}$/.test(v)) return true;
    if (/^[0-9a-f]{24,}$/.test(v)) return true;
    return false;
  }

  // SC_SOL_EXTRACT_LEN32_V4: base58 decode length (Solana pubkey/mint must decode to 32 bytes)
  function _scB58DecodeLen(str){
    const ALPH='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let bytes=[0];
    for(let i=0;i<str.length;i++){
      const v=ALPH.indexOf(str[i]);
      if(v<0) return 0;
      let carry=v;
      for(let j=0;j<bytes.length;j++){
        carry += bytes[j]*58;
        bytes[j]=carry & 255;
        carry >>= 8;
      }
      while(carry>0){ bytes.push(carry & 255); carry >>= 8; }
    }
    for(let k=0;k<str.length && str[k]==='1';k++) bytes.push(0);
    return bytes.length;
  }


  // EVM: 0x + 40 hex
  const evm = /0x[a-fA-F0-9]{40}/g;
  while ((m = evm.exec(text)) !== null) candidates.add(m[0]);

  // BTC: legacy + bech32
  if (opts.allowBase58Like) {
    const btc = /(bc1[a-zA-Z0-9]{25,39}|[13][a-zA-Z0-9]{25,39})/g;
    while ((m = btc.exec(text)) !== null) {
      if (!_hasLooseBoundary(text, m.index, m.index + m[0].length)) continue;
      candidates.add(m[0]);
    }

    // Tron
    const trx = /T[1-9A-HJ-NP-Za-km-z]{33}/g;
    while ((m = trx.exec(text)) !== null) {
      if (!_hasLooseBoundary(text, m.index, m.index + m[0].length)) continue;
      candidates.add(m[0]);
    }

    // Solana (base58, 32вЂ“44 СЃРёРјРІРѕР»Р°)
    const sol = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    while ((m = sol.exec(text)) !== null) {
      const v = m[0];
      if (!_hasLooseBoundary(text, m.index, m.index + v.length)) continue;
      if (_looksHexLikeNoise(v)) continue;
      if (_scB58DecodeLen(v) !== 32) continue; // SC_SOL_EXTRACT_LEN32_V6
      candidates.add(v);
    }
  }

  // TON base64
  const tonb64 = /(EQ|UQ)[A-Za-z0-9_-]{46}/g;
  while ((m = tonb64.exec(text)) !== null) candidates.add(m[0]);

  // TON hex 0:xxxxxxxx
  const tonhex = /0:[0-9a-fA-F]{64}/g;
  while ((m = tonhex.exec(text)) !== null) candidates.add(m[0]);

  const list = Array.from(candidates);

  // РЈР±РёСЂР°РµРј РјСѓСЃРѕСЂ: СЃС‚СЂРѕРєРё, РєРѕС‚РѕСЂС‹Рµ РїСЂРѕСЃС‚Рѕ СЏРІР»СЏСЋС‚СЃСЏ РїРѕРґСЃС‚СЂРѕРєРѕР№ РґСЂСѓРіРёС… Р°РґСЂРµСЃРѕРІ
  const filtered = list.filter(function (addr) {
    if (_looksHexLikeNoise(addr) && !/^0x/i.test(addr) && !/^0:/i.test(addr)) return false;
    return !list.some(function (other) {
      return other.length > addr.length && other.indexOf(addr) !== -1;
    });
  });

  return filtered.slice(0, maxCount);
}

// JSON-RPC helper РґР»СЏ EVM
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
    // SCAMSCAN_CF_BYPASS_FLAG_V1
    if (e && (e.code === 'CLOUDFLARE_CHALLENGE' || String(e.message || '') === 'CLOUDFLARE_CHALLENGE')) {
      cloudflareBypassUsed = true;
    }

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

// Р›С‘РіРєРёР№ РґРµС‚РµРєС‚РѕСЂ РґР»СЏ Solana: program / mint / token-account / wallet
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

    // РџСЂРѕРіСЂР°РјРјР° (СЃРјР°СЂС‚-РєРѕРЅС‚СЂР°РєС‚)
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
        // РќР° РІСЃСЏРєРёР№ СЃР»СѓС‡Р°Р№, РµСЃР»Рё token program, РЅРѕ С‚РёРї РЅРµ СЂР°СЃРїРѕР·РЅР°РЅ
        detectedType = 'token-account';
        solanaEntityType = 'token-account';
      }
    } else {
      // РћР±С‹С‡РЅС‹Р№ Р°РєРєР°СѓРЅС‚ Solana
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

// Р›С‘РіРєРёР№ РґРµС‚РµРєС‚РѕСЂ EVM: РєРѕС€РµР»С‘Рє / РєРѕРЅС‚СЂР°РєС‚ / СЃРµС‚СЊ
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
      // РёРґС‘Рј РґР°Р»СЊС€Рµ
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

// РљРѕРЅС‚РµРЅС‚РЅС‹Р№ СЃРєРѕСЂРёРЅРі: С„СЂР°Р·С‹ в†’ РѕС†РµРЅРєРё
function evaluateTextRisk(text) {
  const lower = (text || '').toLowerCase();
  const matchesSet = new Set();
  let score = 0;

  let hasInvestmentBuzz = false;
  let hasYieldPromise = false;
  let hasReferral = false;
  let hasPayoutMarketing = false;
  let hasTokenSale = false;
  let hasWalletConnectCta = false;

  const soft = [
    'giveaway',
    'airdrop',
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
    'investment package',
    'play-to-earn',
    'earn rewards',
    'gaming investment',
    'investment in games',
    'grow wealth'
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
    'high-yield',
    'double your money',
    '2x your',
    '3x your',
    'annual return',
    'return rate',
    'monthly rewards pool',
    'profit sharing',
    'profit-sharing',
    'quarterly profit distributions',
    'withdraw earnings'
  ];

  const referralStuff = [
    'referral program',
    'affiliate program',
    'multi level marketing',
    'multi-level marketing',
    'mlm',
    'invite friends and earn'
  ];

  const payoutMarketing = [
    'active holders',
    'rewards pool',
    'annual return rate',
    'real profits',
    'turning gameplay into real profits',
    'sustainable earning opportunities',
    'profit shares',
    'community-driven rewards'
  ];

  const tokenSaleMarkers = [
    'ico',
    'initial coin offering',
    'token sale',
    'presale',
    'pre-sale',
    'private sale',
    'public sale',
    'launchpad',
    'native token',
    'utility token',
    'token economy',
    'tokenomics',
    'staking',
    'stake and earn',
    'governance token'
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
  hitGroup(['connect wallet', 'link wallet', 'walletconnect'], 5, () => {
    hasWalletConnectCta = true;
  });
  hitGroup(investmentBuzz, 15, () => {
    hasInvestmentBuzz = true;
  });
  hitGroup(yieldPromises, 20, () => {
    hasYieldPromise = true;
  });
  hitGroup(referralStuff, 15, () => {
    hasReferral = true;
  });
  hitGroup(payoutMarketing, 12, () => {
    hasPayoutMarketing = true;
  });
  hitGroup(tokenSaleMarkers, 14, () => {
    hasTokenSale = true;
  });

  // РљРѕРјР±РёРЅР°С†РёРё РїР°С‚С‚РµСЂРЅРѕРІ
  if (hasYieldPromise) {
    score = Math.max(score, 40);
  }

  if (hasInvestmentBuzz && hasYieldPromise) {
    score = Math.max(score, 60);
  }

  if (hasInvestmentBuzz && hasYieldPromise && hasReferral) {
    score = Math.max(score, 70);
  }

  if (hasInvestmentBuzz && hasPayoutMarketing) {
    score = Math.max(score, 55);
  }

  if (hasYieldPromise && hasPayoutMarketing) {
    score = Math.max(score, 60);
  }

  if (hasInvestmentBuzz && hasYieldPromise && hasPayoutMarketing) {
    score = Math.max(score, 75);
  }

  if (hasTokenSale && hasInvestmentBuzz) {
    score = Math.max(score, 50);
  }

  if (hasTokenSale && hasPayoutMarketing) {
    score = Math.max(score, 55);
  }

  if (hasTokenSale && hasReferral) {
    score = Math.max(score, 58);
  }

  if (hasTokenSale && hasInvestmentBuzz && hasReferral) {
    score = Math.max(score, 65);
  }

  if (hasTokenSale && hasYieldPromise) {
    score = Math.max(score, 68);
  }

  if (hasYieldPromise && hasWalletConnectCta) {
    score = Math.max(score, 45);
  }

  if (score > 80) score = 80;

  return {
    score,
    matches: Array.from(matchesSet),
    flags: {
      hasInvestmentBuzz,
      hasYieldPromise,
      hasReferral,
      hasPayoutMarketing,
      hasTokenSale,
      hasWalletConnectCta
    }
  };
}

function _isTlsCertLocalError(err) {
  const m = String((err && (err.code || err.message)) || '').toLowerCase();
  return (
    m.includes('unable_to_get_issuer_cert_locally') ||
    m.includes('unable to get local issuer certificate') ||
    m.includes('self_signed_cert_in_chain') ||
    m.includes('self signed certificate') ||
    m.includes('unable_to_verify_leaf_signature')
  );
}

function _shouldKeepStaticThinContent(meta) {
  const textLen = Number(meta && meta.textLen) || 0;
  const htmlLen = Number(meta && meta.htmlLen) || 0;
  const uniqueLineRatio = Number(meta && meta.uniqueLineRatio) || 0;
  const rawLines = Number(meta && meta.rawLines) || 0;
  const blockedHint = meta && meta.blockedHint;
  const hasSpaRoot = !!(meta && meta.hasSpaRoot);
  const hasChunks = !!(meta && meta.hasChunks);
  const text = String((meta && meta.text) || '');
  const html = String((meta && meta.html) || '');
  const lowerText = text.toLowerCase();
  const lowerHtml = html.toLowerCase();

  if (blockedHint || hasSpaRoot || hasChunks) return false;
  if (textLen < 120 || textLen >= 500) return false;
  if (htmlLen >= 4500) return false;
  if (rawLines >= 8 && uniqueLineRatio < 0.55) return false;

  const hardBlockSignals = [
    'enable javascript',
    'verify you are human',
    'attention required',
    'access denied',
    'captcha',
    'cloudflare',
    'checking your browser'
  ];
  if (hardBlockSignals.some((needle) => lowerHtml.includes(needle) || lowerText.includes(needle))) {
    return false;
  }

  const suspiciousThinSignals = [
    'connect wallet',
    'claim',
    'airdrop',
    'mint now',
    'presale',
    'seed phrase',
    'support team',
    'synchronize wallet',
    'validate wallet'
  ];
  if (suspiciousThinSignals.some((needle) => lowerText.includes(needle))) {
    return false;
  }

  return true;
}
// РџРѕРїС‹С‚РєР° СЃРєР°С‡Р°С‚СЊ С‡РµСЂРµР· axios
async function fetchPageViaAxios(url, dbg) {
  const reqBase = {
    timeout: 7000,
    maxRedirects: 3,
    headers: { 'User-Agent': 'Mozilla/5.0 ScamScanBot/1.0' }
  };

  let resp;
  let usedInsecureTlsRetry = false;

  try {
    resp = await axios.get(url, reqBase);
  } catch (err) {
    if (_isTlsCertLocalError(err)) {
      // SC_CONTENT_AXIOS_TLS_RETRY_V1: fallback for broken/missing CA chains on target side.
      usedInsecureTlsRetry = true;
      resp = await axios.get(url, Object.assign({}, reqBase, {
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      }));
    } else {
      throw err;
    }
  }

  // SCAMSCAN_CF_FORCE_PUPPETEER_V3
  const __html = String((resp && resp.data) ? resp.data : "");
  // SC_CONTENT_DEBUG_META_V2
  if (dbg && typeof dbg === "object") {
    try {
      dbg.axiosStatus = resp && resp.status;
      dbg.axiosContentType = resp && resp.headers && (resp.headers["content-type"] || resp.headers["Content-Type"]);
      dbg.axiosFinalUrl =
        (resp && resp.request && resp.request.res && resp.request.res.responseUrl) ||
        (resp && resp.request && resp.request._redirectable && resp.request._redirectable._currentUrl) ||
        url;
      dbg.axiosHtmlLen = __html.length;
      dbg.axiosTlsInsecureRetry = !!usedInsecureTlsRetry;
    } catch (_) {}
  }

  if (!__html || __html.trim().length < 200 || _looksLikeCloudflare(__html)) {
    const e = new Error('CLOUDFLARE_CHALLENGE');
    e.code = 'CLOUDFLARE_CHALLENGE';
    throw e;
  }
  const ct = resp.headers['content-type'] || '';
  if (!/text\/html|application\/xhtml\+xml/i.test(ct)) {
    throw new Error('NON_HTML_CONTENT');
  }

  return resp.data;
}

// Р“Р»Р°РІРЅР°СЏ С„СѓРЅРєС†РёСЏ Р°РЅР°Р»РёР·Р° РєРѕРЅС‚РµРЅС‚Р° СЃР°Р№С‚Р°
async function analyzeWebsiteContent(domain) {
  const url = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;

  // SC_CONTENT_DEBUG_META_V2
  const debugMeta = {
    domain,
    inputUrl: url,
    startedAt: new Date().toISOString(),
  };

  let html = '';
  let text = '';
  let source = 'axios';
  let cloudflareBypassUsed = false;

  console.log(`[Content] Starting analysis for ${url}...`);

    // РџСѓС‚СЊ 1 вЂ” axios/static + quality gate
    let axiosFallbackReason = null;
    try {
      html = await fetchPageViaAxios(url, debugMeta);
      text = _extractPreferredTextFromHtml(html) || stripHtmlToText(html);

      const staticCompact = String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const staticLines = String(text || '')
        .split(/\r?\n/)
        .map((x) => String(x || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const staticUniqueLines = new Set(staticLines.map((x) => x.toLowerCase())).size;
      const staticUniqueLineRatio = staticLines.length ? Number((staticUniqueLines / staticLines.length).toFixed(3)) : 1;
      const staticBlockedHint = _blockedHintFromHtml(html, text);
      const hasSpaRoot = /<div[^>]+id="(?:root|app)"[^>]*>/i.test(html);
      const hasChunks =
        /chunk|webpack|vite|react|vue/i.test(html) ||
        /<script[^>]+chunk[^>]*><\/script>/i.test(html);
      const staticThinAccepted = _shouldKeepStaticThinContent({
        text: staticCompact,
        html,
        textLen: staticCompact.length,
        htmlLen: String(html || '').length,
        rawLines: staticLines.length,
        uniqueLineRatio: staticUniqueLineRatio,
        blockedHint: staticBlockedHint,
        hasSpaRoot,
        hasChunks
      });

      let staticReason = null;
      if (!staticCompact.length) {
        staticReason = 'AXIOS_NO_TEXT';
      } else if (staticBlockedHint) {
        staticReason = 'AXIOS_BLOCKED_' + String(staticBlockedHint).toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
      } else if (staticCompact.length <= 180 && String(html || '').length >= 3000) {
        staticReason = 'AXIOS_META_ONLY';
      } else if (staticLines.length >= 8 && staticUniqueLineRatio < 0.55) {
        staticReason = 'AXIOS_REPETITIVE_TEXT';
      } else if (staticCompact.length < 500 && !staticThinAccepted) {
        staticReason = 'AXIOS_TEXT_THIN';
      } else if (hasSpaRoot && hasChunks) {
        staticReason = 'SPA_DETECTED';
      }

      try {
        debugMeta.staticProbe = {
          textLen: staticCompact.length,
          htmlLen: String(html || '').length,
          blockedHint: staticBlockedHint || null,
          hasSpaRoot,
          hasChunks,
          thinAccepted: staticThinAccepted,
          rawLines: staticLines.length,
          uniqueLineRatio: staticUniqueLineRatio,
          passed: !staticReason,
          reason: staticReason || (staticThinAccepted ? 'STATIC_THIN_OK' : 'STATIC_OK')
        };
      } catch (_) {}

      if (staticReason) {
        axiosFallbackReason = staticReason;
        console.log('[Content] axios quality gate -> Puppeteer fallback:', staticReason);
        throw new Error(staticReason);
      }

      source = 'axios';
    } catch (e) {
      // РџСѓС‚СЊ 2 вЂ” Puppeteer
      console.log(`[Content] Axios failed: ${e.message} -> Puppeteer fallback`);
      try {
        debugMeta.axiosError = (e && e.message) ? e.message : String(e);
        debugMeta.axiosErrorCode = e && e.code;
        debugMeta.staticFallbackReason = axiosFallbackReason || ((e && e.message) ? e.message : String(e));
      } catch (_) {}
      try {
        const p = await getPageContent(url);
        try {
          debugMeta.puppeteerFinalUrl = p && (p.finalUrl || p.url || p.resolvedUrl || p.finalURL);
          debugMeta.puppeteerHtmlLen = (p && p.html) ? String(p.html).length : 0;
          debugMeta.puppeteerTextLen = (p && p.text) ? String(p.text).length : 0;
          debugMeta.puppeteerTitle = p && p.title;
        } catch (_) {}
        if (!p || !p.html) throw new Error('EMPTY_RENDER');
        html = p.html;
        const _pt = (p.text ? String(p.text).trim() : '');
        const _ht = _extractPreferredTextFromHtml(p.html) || stripHtmlToText(p.html);
        text = (_pt && _pt.length >= 200) ? _pt : (_ht && _ht.length > _pt.length ? _ht : _pt);
        source = 'puppeteer';
      } catch (err) {
        console.log('[Content] Puppeteer failed:', err.message);
        const failMeta = _classifyFetchFailure(e, err);
        try {
          debugMeta.finalSource = failMeta.source;
          debugMeta.fetchFailureReason = failMeta.reason;
          debugMeta.fetchFailureError = String((err && (err.message || err.code)) || '');
          debugMeta.blockedHint = debugMeta.blockedHint || _blockedHintFromHtml('', String((e && e.message) || '') + ' ' + String((err && err.message) || ''));
        } catch (_) {}
        return {
          score: 0,
          matches: [],
          warnings: [failMeta.warning],
          source: failMeta.source,
          quality: 'failed',
          qualityReason: failMeta.reason,
          blockedBy: _blockedByFromReason(debugMeta.blockedHint || failMeta.reason),
          fetchFailureCategory: failMeta.reason,
          debug: debugMeta,
          wallets: [],
          rawWallets: [],
          walletWarnings: [failMeta.warning]
        };
      }
    }

  // 1) РљРѕРЅС‚РµРЅС‚РЅС‹Р№ Р°РЅР°Р»РёР· С‚РµРєСЃС‚Р°
  const supplementalText = stripHtmlToText(html);
  const textEval = evaluateTextRisk(text);
  const supplementalEval = supplementalText && supplementalText !== text
    ? evaluateTextRisk(supplementalText)
    : { score: 0, matches: [], flags: {} };
  let riskScore = Math.max(Number(textEval.score) || 0, Number(supplementalEval.score) || 0);
  const matches = Array.from(new Set([]
    .concat(Array.isArray(textEval.matches) ? textEval.matches : [])
    .concat(Array.isArray(supplementalEval.matches) ? supplementalEval.matches : [])));

  // SC_CONTENT_DEBUG_META_V2
  try {
    debugMeta.finalSource = source;
    debugMeta.finalUrl = debugMeta.puppeteerFinalUrl || debugMeta.axiosFinalUrl || url;
    debugMeta.htmlLen = html ? String(html).length : 0;
    debugMeta.textLen = text ? String(text).length : 0;
    debugMeta.blockedHint = _blockedHintFromHtml(html, text);
    debugMeta.matchCount = Array.isArray(matches) ? matches.length : 0;

    const rawText = String(text || '');
    const compactText = rawText.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const lowerCompact = compactText.toLowerCase();
    debugMeta.matchContexts = (Array.isArray(matches) ? matches : []).slice(0, 20).map((m) => {
      const mm = String(m || '').replace(/\s+/g, ' ').trim();
      const needle = mm.toLowerCase();
      const i = needle ? lowerCompact.indexOf(needle) : -1;
      const ctx = i >= 0 ? compactText.slice(Math.max(0, i - 90), Math.min(compactText.length, i + needle.length + 160)) : '';
      return { m: mm, idx: i, ctx };
    });
  } catch (_) {}
  const flags = {
    hasInvestmentBuzz: !!((textEval.flags && textEval.flags.hasInvestmentBuzz) || (supplementalEval.flags && supplementalEval.flags.hasInvestmentBuzz)),
    hasYieldPromise: !!((textEval.flags && textEval.flags.hasYieldPromise) || (supplementalEval.flags && supplementalEval.flags.hasYieldPromise)),
    hasReferral: !!((textEval.flags && textEval.flags.hasReferral) || (supplementalEval.flags && supplementalEval.flags.hasReferral)),
    hasPayoutMarketing: !!((textEval.flags && textEval.flags.hasPayoutMarketing) || (supplementalEval.flags && supplementalEval.flags.hasPayoutMarketing)),
    hasTokenSale: !!((textEval.flags && textEval.flags.hasTokenSale) || (supplementalEval.flags && supplementalEval.flags.hasTokenSale))
  };

  // 2) РџРѕРёСЃРє Р°РґСЂРµСЃРѕРІ
  const rawWallets = extractWalletCandidates(text);
  const wallets = [];
  const walletWarnings = [];
  const contentWarnings = [];

  let hasEvmOrBscContract = false;

  for (const address of rawWallets) {
    let detectedType = 'unknown';
    let detectedChain = 'unknown';
    let solanaEntityType = null;

    try {
      detectedType = detectType(address) || 'unknown';
      detectedChain = detectChain(address) || 'unknown';
    } catch (e) {
      // РїРѕС„РёРі
    }

    // РЈС‚РѕС‡РЅСЏРµРј EVM-Р°РґСЂРµСЃР° С‡РµСЂРµР· RPC
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
    // РЈС‚РѕС‡РЅСЏРµРј Solana-Р°РґСЂРµСЃР° С‡РµСЂРµР· RPC
    else if (detectedChain === 'solana-like') {
      try {
        const info = await detectSolanaAddressInfo(address);
        if (info) {
          if (info.detectedType) detectedType = info.detectedType;
          if (info.detectedChain) detectedChain = info.detectedChain;
          if (info.solanaEntityType) solanaEntityType = info.solanaEntityType;
        }
      } catch (e) {
        // РѕС€РёР±РєР° СѓР¶Рµ Р·Р°Р»РѕРіР°РЅР° РІРЅСѓС‚СЂРё detectSolanaAddressInfo
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

    if (
      detectedChain !== 'unknown' &&
      detectedType !== 'unknown'
    ) {
      wallets.push(walletEntry);
    }
  }

  if (wallets.length > 0) {
    walletWarnings.push(
      'Displaying crypto addresses on a website is a common scam indicator.'
    );
    riskScore += 5; // Р»С‘РіРєРёР№ Р±РѕРЅСѓСЃ Р·Р° С‚Рѕ, С‡С‚Рѕ РґРµРЅСЊРіРё С„РёРіСѓСЂРёСЂСѓСЋС‚
  }

  // 3) РЈСЃРёР»РµРЅРёРµ СЂРёСЃРєР° РґР»СЏ С‚РёРїРёС‡РЅС‹С… "РёРЅРІРµСЃС‚-Р»РµРЅРґРёРЅРіРѕРІ" СЃ РєРѕРЅС‚СЂР°РєС‚Р°РјРё
  if (hasEvmOrBscContract && flags.hasInvestmentBuzz && flags.hasYieldPromise) {
    riskScore = Math.max(riskScore, 80); // SCAM СѓСЂРѕРІРµРЅСЊ
  } else if (flags.hasInvestmentBuzz && flags.hasYieldPromise) {
    riskScore = Math.max(riskScore, 60); // РјРёРЅРёРјСѓРј SUSPICIOUS
  }

  if (wallets.length > 0 && (flags.hasInvestmentBuzz || flags.hasYieldPromise || flags.hasPayoutMarketing)) {
    riskScore = Math.max(riskScore, 45);
  }

  if (wallets.length >= 2 && flags.hasInvestmentBuzz && (flags.hasYieldPromise || flags.hasPayoutMarketing)) {
    riskScore = Math.max(riskScore, 70);
  }

  if (flags.hasInvestmentBuzz && flags.hasPayoutMarketing) {
    contentWarnings.push(
      'The page mixes investment-style marketing with payout/reward language, which is common in high-risk schemes.'
    );
  }

  if (flags.hasTokenSale && (flags.hasReferral || flags.hasPayoutMarketing || flags.hasInvestmentBuzz)) {
    contentWarnings.push(
      'The page promotes a token sale or token economy together with rewards, referral, or investment-style language.'
    );
  }

  if (wallets.length > 0 && (flags.hasInvestmentBuzz || flags.hasYieldPromise || flags.hasPayoutMarketing)) {
    contentWarnings.push(
      'Crypto addresses are embedded directly on a page that also markets earnings, rewards, or investment returns.'
    );
  }

    if (riskScore > 80) riskScore = 80;

    const compact = String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

    try {
      debugMeta.compactTextLen = compact.length;
      debugMeta.pageTextSnippetHeadLen = compact ? compact.slice(0, 800).length : 0;
    } catch (_) {}

    const qualityMeta = (() => {
      const rawLines = String(text || '')
        .split(/\r?\n/)
        .map((x) => String(x || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      const lowerLines = rawLines.map((x) => x.toLowerCase());
      const uniqueLines = new Set(lowerLines).size;
      const uniqueLineRatio = rawLines.length ? Number((uniqueLines / rawLines.length).toFixed(3)) : 1;
      const htmlLen = String(html || '').length;
      const blocked = Boolean(debugMeta.blockedHint);
      const metaOnly = compact.length > 0 && compact.length <= 180 && htmlLen >= 3000;
      const repetitive = rawLines.length >= 8 && uniqueLineRatio < 0.55;
      const thin = compact.length > 0 && compact.length < 500;

      let level = 'ok';
      let reason = 'enough_text';

      if (!compact.length) {
        level = 'empty';
        reason = 'no_text';
      } else if (blocked) {
        level = 'blocked';
        reason = String(debugMeta.blockedHint || 'blocked').trim() || 'blocked';
      } else if (metaOnly) {
        level = 'thin';
        reason = 'meta_only';
      } else if (repetitive) {
        level = 'thin';
        reason = 'repetitive_text';
      } else if (thin) {
        level = 'thin';
        reason = 'too_short';
      }

      return {
        level,
        reason,
        blocked,
        textLen: compact.length,
        htmlLen,
        rawLines: rawLines.length,
        uniqueLines,
        uniqueLineRatio
      };
    })();

    const normalizedSource = (() => {
      const rawSource = String(source || '').trim().toLowerCase();

      if (qualityMeta.level === 'blocked') {
        return rawSource === 'puppeteer' ? 'puppeteer_blocked' : 'static_blocked';
      }

      if (rawSource === 'puppeteer') {
        return qualityMeta.level === 'ok' ? 'puppeteer_ok' : 'puppeteer_thin';
      }

      if (rawSource === 'axios' || rawSource === 'html' || rawSource === 'static') {
        if (qualityMeta.reason === 'meta_only') return 'fallback_meta_only';
        return qualityMeta.level === 'ok' ? 'static_ok' : 'static_thin';
      }

      return rawSource || (qualityMeta.level === 'ok' ? 'static_ok' : 'static_thin');
    })();

    try {
      debugMeta.quality = qualityMeta;
      debugMeta.normalizedSource = normalizedSource;
    } catch (_) {}

    if (qualityMeta.blocked) {
      contentWarnings.push(
        'Page content appears to be blocked by captcha, challenge, or access controls. Content-based verdict may be incomplete.'
      );
    } else if (qualityMeta.level === 'empty') {
      contentWarnings.push(
        'Very little readable page content was available for analysis.'
      );
    }

    return {
      score: riskScore,
      // SCAMSCAN_PAGE_SNIPPET_V2
      pageTextSnippet: (() => {
        if (!compact) return null;

        const hits = (Array.isArray(matches) ? matches : [])
          .map((x) => String(x || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);

        const lowerCompact = compact.toLowerCase();
        for (const hit of hits) {
          const needle = hit.toLowerCase();
          const idx = lowerCompact.indexOf(needle);
          if (idx >= 0) {
            const start = Math.max(0, idx - 220);
            const end = Math.min(compact.length, idx + needle.length + 380);
            return compact.slice(start, end);
          }
        }

        return compact.slice(0, 800);
      })(),
      matches,
      warnings: contentWarnings,
      source: normalizedSource,
      rawSource: source,
      quality: qualityMeta.level,
      qualityReason: qualityMeta.reason,
      blockedBy: _blockedByFromReason(debugMeta.blockedHint || qualityMeta.reason),
      fetchFailureCategory: qualityMeta.level === 'failed' ? qualityMeta.reason : null,
      cloudflareBypassUsed,
      // SC_CONTENT_DEBUG_META_V3
      debug: debugMeta,
      wallets,
      rawWallets,
      walletWarnings
    };
  }
module.exports = { analyzeWebsiteContent };

