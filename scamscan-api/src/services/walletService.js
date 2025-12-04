const { analyzeSolanaAddressOnChain } = require('./solanaService');
const { analyzeTronAddressOnChain } = require('./tronService');
const { analyzeTonAddressOnChain } = require('./tonService');
const { analyzeBtcAddressOnChain } = require('./btcService');
const { scanNetwork, checkHoneypot, getTokenMetaViaRpc } = require("./evmService");

// Универсальный форматтер больших чисел (wei → нормальный вид по decimals)
function formatBalance(balanceWei, decimals) {
  try {
    const wei = BigInt(balanceWei);
    const base = 10n ** BigInt(decimals);
    const whole = wei / base;
    const fraction = wei % base;
    const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
    if (!fractionStr) return whole.toString();
    return whole.toString() + "." + fractionStr.slice(0, 6);
  } catch (e) { return "0"; }
}

// Приведение балансов к единому виду для фронта
// ETH/BNB: уже отформатированный balance → displayBalance
// Tron / TON / Solana: баланс в минимальных единицах → считаем formatted + displayBalance
// Bitcoin: не трогаем, просто кладём в displayBalance как есть
function addFormattedBalance(onChainData) {
  try {
    if (!onChainData || !Array.isArray(onChainData.networks)) return onChainData;

    onChainData.networks = onChainData.networks.map((net) => {
      const newNet = { ...net };

      // EVM (ETH / BNB) — уже есть человекочитаемый balance
      if (
        newNet.nativeCurrency &&
        newNet.nativeCurrency.symbol &&
        (newNet.nativeCurrency.symbol === 'ETH' || newNet.nativeCurrency.symbol === 'BNB')
      ) {
        if (newNet.balance !== undefined) {
          newNet.displayBalance = String(newNet.balance);
        }
        return newNet;
      }

      // Solana / Tron / TON и другие, где balance в минимальных единицах (целое число)
      if (
        newNet.balance !== undefined &&
        newNet.nativeCurrency &&
        typeof newNet.nativeCurrency.decimals === "number" &&
        /^[0-9]+$/.test(String(newNet.balance)) // только целые, без точки
      ) {
        const formatted = formatBalance(String(newNet.balance), newNet.nativeCurrency.decimals);
        newNet.balanceFormatted = formatted;
        newNet.displayBalance = formatted;
        return newNet;
      }

      // Фоллбек (например, Bitcoin, где balance уже десятичный):
      if (newNet.balance !== undefined) {
        newNet.displayBalance = String(newNet.balance);
      }

      return newNet;
    });

    return onChainData;
  } catch (e) {
    return onChainData;
  }
}

const NATIVE_CURRENCIES = {
  ethereum: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
  bsc:      { name: 'BNB Chain', symbol: 'BNB', decimals: 18 }
};

function evaluateRisk(address, chain, scanResults) {
    let score = 0;
    const warnings = [];

    const blacklists = [
        process.env.TON_SCAM_WALLETS,
        process.env.ETH_SCAM_WALLETS,
        process.env.TRON_SCAM_WALLETS,
        process.env.BTC_SCAM_WALLETS,
        process.env.SOL_SCAM_WALLETS
    ].filter(Boolean).join(',').toLowerCase().split(',');

    if (blacklists.includes(address.toLowerCase())) {
        return { score: 100, warnings: ["CRITICAL: Address found in internal SCAM BLACKLIST."] };
    }

    scanResults.forEach(res => {
        let activityCount = 0;
        if (res.txCount !== undefined) activityCount = res.txCount;
        else if (res.txsChecked !== undefined) activityCount = res.txsChecked;

        res.txCount = activityCount;

        const netName = (res.network || '').toString();

        // 1. HONEYPOT (CRITICAL) — EVM contracts only
        if (res.isContract && res.honeypotCheck && res.honeypotCheck.isHoneypot) {
            score = 100;
            warnings.push(`[${netName}] DETECTED HONEYPOT CONTRACT!`);
        }

        // 1b. Honeypot transfer simulation failure (HIGH RISK, beta, EVM only)
        if (res.isContract && res.honeypotCheck && Array.isArray(res.honeypotCheck.flags)) {
            if (res.honeypotCheck.flags.includes('TRANSFER_SIMULATION_FAILED')) {
                score = Math.max(score, 60);
                warnings.push(`[${netName}] Honeypot simulation failed (beta: potential transfer/sell restrictions).`);
            }
        }

        // 2. FRESH WALLET (CALIBRATED, applies to all non-contract chains)
        if (!res.isContract && res.status === 'active') {
             if (activityCount > 0 && activityCount <= 5) {
                 // 35 баллов = Medium Risk (Caution), но не SCAM.
                 score = Math.max(score, 35);
                 warnings.push(`[${netName}] Caution: Very fresh wallet (< 5 transactions).`);
             }
             else if (activityCount > 5 && activityCount < 20) {
                 score = Math.max(score, 10);
                 // warnings.push(`[${netName}] Info: New wallet.`);
             }
        }

        // 3. SIGNALS FROM SERVICES (Etherscan / TronGrid / Blockstream / etc.)
        if (res.scamSignals && res.scamSignals.length > 0) {
             res.scamSignals.forEach(sig => {
                 if (!sig) return;
                 const lower = sig.toLowerCase();
                 warnings.push(`[${netName}] ${sig}`);

                 // Очень свежий адрес по данным сканера (любой сети)
                 if (lower.includes('less than 24h') || lower.includes('created today')) {
                     score = Math.max(score, 65); // High Risk (almost SCAM)
                 }
                 // Fresh / very fresh (до ~7 дней)
                 else if (lower.includes('fresh')) {
                     score = Math.max(score, 40); // Medium/High
                 }
                 // Специальный кейс для "обнулённых" адресов:
                 // например BTC: "Zero current balance — all funds moved out."
                 else if (lower.includes('zero current balance') || lower.includes('all funds moved out')) {
                     score = Math.max(score, 50); // Высокий риск: адрес выглядит как полностью слитый / транзитный
                 }
                 // Остальные сигналы сканеров: умеренное повышение риска
                 else {
                     score = Math.max(score, 20);
                 }
             });
        }
    });

    return { score, warnings };
}

async function analyzeWallet(input, basicInfo) {
    let risk = basicInfo.risk || 'low';
    const chain = basicInfo.detectedChain;
    let onChainData = { provider: 'unknown', networks: [] };

    if (chain === 'solana-like') {
        const res = await analyzeSolanaAddressOnChain(input);
        onChainData = res.onChain;
    }
    else if (chain === 'tron-like') {
        const res = await analyzeTronAddressOnChain(input);
        onChainData = res.onChain;
    }
    else if (chain === 'ton-like') {
        const res = await analyzeTonAddressOnChain(input);
        onChainData = res.onChain;
    }
    else if (chain === 'bitcoin-like') {
        const res = await analyzeBtcAddressOnChain(input);
        onChainData = res.onChain;
    }
    else {
        let networksToCheck = ['ethereum', 'bsc'];
        const scanPromises = networksToCheck.map(async (net) => {
            try {
                const basicScan = await scanNetwork(net, input);
                if (basicScan.error) return { network: net, error: basicScan.error };

                if (basicScan.txCount === 0 && BigInt(basicScan.balanceWei) === 0n) {
                     return { ...basicScan, status: 'empty', nativeCurrency: NATIVE_CURRENCIES[net] };
                }

                const hpCheck = await checkHoneypot(net, input);
                let isContract = hpCheck.isContract;
                let tokenMeta = null;
                if (isContract) tokenMeta = await getTokenMetaViaRpc(net, input);

                return {
                    network: net,
                    balanceWei: basicScan.balanceWei,
                    balance: formatBalance(basicScan.balanceWei, NATIVE_CURRENCIES[net].decimals),
                    txCount: basicScan.txCount,
                    isContract: (isContract && tokenMeta) ? true : false,
                    tokenMeta: tokenMeta,
                    nativeCurrency: NATIVE_CURRENCIES[net],
                    honeypotCheck: (isContract && tokenMeta) ? hpCheck : null,
                    status: 'active',
                    scamSignals: basicScan.scamSignals || []
                };
            } catch (e) {
                return { network: net, error: e.message };
            }
        });

        const evmResults = await Promise.all(scanPromises);
        const validResults = evmResults.filter(r => !r.error);
        onChainData = {
            provider: 'rpc',
            type: validResults.find(r => r.isContract) ? 'contract' : 'wallet',
            networks: validResults.length > 0 ? validResults : evmResults
        };
    }

    // Нормализуем балансы для всех сетей (добавляем displayBalance и balanceFormatted где надо)
    onChainData = addFormattedBalance(onChainData);

    const riskAnalysis = evaluateRisk(input, chain, onChainData.networks || []);

    let finalScore = riskAnalysis.score;

    // VERDICT MAPPING (CALIBRATED)
    if (finalScore >= 80) risk = 'critical';       // SCAM
    else if (finalScore >= 60) risk = 'high';      // DANGEROUS
    else if (finalScore >= 35) risk = 'medium';    // CAUTION (Fresh wallets fall here)
    else risk = 'low';                             // SAFE

    // Override verdict text for clarity
    let verdictText = 'SAFE';
    if (risk === 'critical') verdictText = 'SCAM';
    if (risk === 'high') verdictText = 'HIGH RISK';
    if (risk === 'medium') verdictText = 'SUSPICIOUS'; // Or CAUTION

    return {
        risk,
        riskScore: finalScore,
        verdict: verdictText, // Explicit verdict field
        warnings: [...new Set(riskAnalysis.warnings)],
        onChain: onChainData
    };
}

module.exports = { analyzeWallet };
