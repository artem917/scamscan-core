require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// --- Configs ---
const { PORT, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX } = require('./src/config/constants');
const { RPC_PROVIDERS } = require('./src/config/rpc');

// --- Utils ---
const { detectType, detectChain } = require('./src/utils/domainUtils');


// --- Helpers ---
function normalizeDomainForWhois(value) {
  if (!value) return value;
  try {
    let v = String(value).trim();
    if (!/^https?:\/\//i.test(v)) {
      v = 'http://' + v;
    }
    const u = new URL(v);
    return u.hostname || value;
  } catch (e) {
    return value;
  }
}

// --- Services ---
const { fetchDomainWhois, analyzeWhois } = require('./src/services/whoisService');
const { analyzeWebsiteContent } = require('./src/services/contentService');
const { analyzeWallet } = require('./src/services/walletService');


// URL whitelist and gray-demo adjustments for URL checks
const URL_DOMAIN_WHITELIST = new Set([
  // ScamScan own domain
  "scamscan.online",
  "www.scamscan.online",

  // Search engines
  "google.com",
  "www.google.com",
  "yandex.ru",
  "www.yandex.ru",
  "ya.ru",
  "www.ya.ru",
  "bing.com",
  "www.bing.com",
  "duckduckgo.com",
  "www.duckduckgo.com",

  // Explorers
  "etherscan.io",
  "www.etherscan.io",
  "bscscan.com",
  "www.bscscan.com",
  "polygonscan.com",
  "www.polygonscan.com",
  "arbiscan.io",
  "www.arbiscan.io",
  "snowtrace.io",
  "www.snowtrace.io",
  "ftmscan.com",
  "www.ftmscan.com",
  "basescan.org",
  "www.basescan.org",

  // Centralized exchanges
  "binance.com",
  "www.binance.com",
  "binance.us",
  "www.binance.us",
  "coinbase.com",
  "www.coinbase.com",
  "kraken.com",
  "www.kraken.com",
  "pro.kraken.com",
  "bybit.com",
  "www.bybit.com",
  "okx.com",
  "www.okx.com",
  "kucoin.com",
  "www.kucoin.com",
  "htx.com",
  "www.htx.com",
  "gate.io",
  "www.gate.io",
  "mexc.com",
  "www.mexc.com",
  "bitfinex.com",
  "www.bitfinex.com",
  "bitstamp.net",
  "www.bitstamp.net",
  "crypto.com",
  "www.crypto.com",
  "bitget.com",
  "www.bitget.com",
  "bingx.com",
  "www.bingx.com",

  // DEX & DeFi fronts
  "uniswap.org",
  "app.uniswap.org",
  "pancakeswap.finance",
  "app.pancakeswap.finance",
  "1inch.io",
  "app.1inch.io",
  "curve.fi",
  "app.curve.fi",
  "balancer.fi",
  "app.balancer.fi",
  "traderjoexyz.com",
  "app.traderjoexyz.com",
  "quickswap.exchange",
  "sushi.com",
  "app.sushi.com",
  "raydium.io",
  "jup.ag",

  // Wallets / key vendors
  "metamask.io",
  "trustwallet.com",
  "www.trustwallet.com",
  "phantom.app",
  "www.phantom.app",
  "rabby.io",
  "www.rabby.io",
  "ledger.com",
  "www.ledger.com",
  "trezor.io",
  "www.trezor.io"
]);

function applyUrlDomainWhitelist(result) {
  try {
    if (!result || result.type !== "url" || !result.input) return result;

    const input = String(result.input);
    let host = "";
    let path = "/";
    try {
      const u = new URL(input);
      host = (u.hostname || "").toLowerCase();
      path = u.pathname || "/";
    } catch (e) {
      return result;
    }

    const content = result.details && result.details.content ? result.details.content : null;

    // Специальный демо-URL: /demo-gray-url на нашем домене -> фиксируем medium
    if (host === "scamscan.online" && path.indexOf("/demo-gray-url") === 0 && content) {
      if (typeof content.score === "number") {
        content.score = 60;
      }
      content.risk = "medium";

      if (typeof result.riskScore === "number") {
        result.riskScore = Math.min(result.riskScore, 60);
      } else {
        result.riskScore = 60;
      }

      if (!result.risk || result.risk === "high" || result.risk === "critical") {
        result.risk = "medium";
      }
      if (result.verdict === "SCAM") {
        result.verdict = "WARNING";
      }
      return result;
    }

    
    // Mark whitelisted domain in result for frontend tech-log
    if (URL_DOMAIN_WHITELIST.has(host)) {
      result.whitelistedDomain = host;
      if (!result.details) result.details = {};
      if (!result.details.whitelist) {
        result.details.whitelist = {
          domain: host,
          source: "global-url-whitelist"
        };
      }
    }

// Глобальный whitelist доменов: режем максимум, но не выкидываем сигналы
    if (URL_DOMAIN_WHITELIST.has(host) && content) {
      if (typeof content.score === "number") {
        content.score = Math.min(content.score, 60);
      }
      if (typeof result.riskScore === "number") {
        result.riskScore = Math.min(result.riskScore, 60);
      }
      if (result.risk === "high" || result.risk === "critical") {
        result.risk = "medium";
      }
      if (result.verdict === "SCAM") {
        result.verdict = "WARNING";
      }
    }

    return result;
  } catch (e) {
    return result;
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// --- Rate Limiter ---
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  message: { error: "Too many requests, please try again later." }
});
app.use('/api/', limiter);

// --- Routes ---
app.get("/api/ping", (req, res) => {
  res.json({ status: "ok" });
});


app.get('/api/check', async (req, res) => {
  const type = req.query.type;   // 'url' | 'wallet' | 'contract' | 'ip'
  const value = req.query.value; // e.g. 'google.com'

  if (!value) {
    return res.status(400).json({ error: "Missing 'value' parameter" });
  }

  // Auto-detect type if not provided or generic
  const detectedType = (type && type !== 'auto') ? type : detectType(value);
  
  const result = {
    input: value,
    type: detectedType,
    riskScore: 0,
    verdict: "SAFE",
    warnings: [],
    details: {}
  };

  let partialAnalysis = false;

  try {
    // === DOMAIN / URL ===
    if (detectedType === 'url' || detectedType === 'domain') {
        const domainForWhois = normalizeDomainForWhois(value);
        const whoisAnalysis = await analyzeWhois(domainForWhois);

        // Basic Content Scan
        let contentAnalysis = { score: 0, warnings: [] };
        try {
            contentAnalysis = await analyzeWebsiteContent(value);
        } catch (e) {
            console.error("Content scan failed:", e.message);
        }

        // Combine Risks
        const whoisScore = typeof whoisAnalysis.riskScore === "number" ? whoisAnalysis.riskScore : 0;
        const contentScore = typeof contentAnalysis.score === "number" ? contentAnalysis.score : 0;
        result.riskScore = Math.min(100, whoisScore + contentScore);

        const allWarnings = [
          ...(whoisAnalysis.warnings || []),
          ...(contentAnalysis.warnings || []),
          ...(contentAnalysis.walletWarnings || []),
        ];
        result.warnings = allWarnings;

        if (contentAnalysis && contentAnalysis.source === "failed") {
          partialAnalysis = true;
        }

        result.details = {
            whois: whoisAnalysis,
            content: contentAnalysis
        };
    }
    
    // === WALLET / CONTRACT ===
    else if (detectedType === 'wallet' || detectedType === 'contract') {
        const chain = detectChain(value);
        const walletAnalysis = await analyzeWallet(value, { detectedChain: chain });
        
        // Calculate Risk
        let riskNum = typeof walletAnalysis.riskScore === 'number'
          ? walletAnalysis.riskScore
          : 0;
        if (riskNum === 0) {
          if (walletAnalysis.risk === 'critical') riskNum = 95;
          else if (walletAnalysis.risk === 'high') riskNum = 85;
          else if (walletAnalysis.risk === 'medium') riskNum = 50;
          else riskNum = 10;
        }
        
        result.riskScore = riskNum;
        result.risk = walletAnalysis.risk || result.risk;
        result.warnings = walletAnalysis.warnings;
        result.details = {
            chain: chain,
            onChain: walletAnalysis.onChain
        };
    }
    
    // === UNKNOWN ===
    else {
        result.warnings.push("Unknown input type. Cannot analyze.");
    }

    // Verdict Logic
    if (result.riskScore >= 75) result.verdict = "SCAM";
    else if (result.riskScore >= 40) result.verdict = "SUSPICIOUS";
    else if (partialAnalysis) result.verdict = "WARNING";
    else result.verdict = "SAFE";

    if (partialAnalysis) {
      result.warnings.push("Content analysis was not completed for this URL (DNS / network issues); verdict is based on limited data.");
    }

    const finalResult = applyUrlDomainWhitelist(result);
    return res.json(finalResult);

  } catch (error) {
    console.error("Analysis Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

// --- Start Server ---
app.listen(3000, () => {
  console.log(`ScamScan V2 API running on port ${PORT}`);
  console.log(`Mode: Refactored Modular Architecture`);
});
