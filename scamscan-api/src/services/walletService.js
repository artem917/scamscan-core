const { analyzeSolanaAddressOnChain } = require('./solanaService');
const { analyzeTronAddressOnChain } = require('./tronService');
const { analyzeTonAddressOnChain } = require('./tonService');
const { analyzeBtcAddressOnChain } = require('./btcService');
const { scanNetwork, checkHoneypot, simulateTradingPaths, getTokenMetaViaRpc, getContractControl, fetchDexLiquiditySummary, fetchExplorerHolderSummary } = require("./evmService");

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
  bsc:      { name: 'BNB Chain', symbol: 'BNB', decimals: 18 },
  base:     { name: 'Base', symbol: 'ETH', decimals: 18 }
};

// SCAMSCAN_ONCHAIN_UNIFY_BEGIN
function normalizeAddressForExplorer(addr) {
  const a = String(addr || "").trim();
  if (!a) return a;
  // EVM-style addresses => lowercase for consistency
  if (a.startsWith("0x") && a.length === 42) return a.toLowerCase();
  return a;
}

function buildExplorerUrl(netName, addr, net) {
  const a = String(addr || "").trim();
  if (!a) return null;

  const n = String(netName || "").toLowerCase();

  if (n === "ethereum") return "https://etherscan.io/address/" + a;
  if (n === "bsc") return "https://bscscan.com/address/" + a;
  if (n === "base") return "https://basescan.org/address/" + a;

  if (n === "tron") {
    const isC = !!(net && (net.isContract || net.isTokenContract));
    return isC ? ("https://tronscan.org/#/contract/" + a) : ("https://tronscan.org/#/address/" + a);
  }

  if (n === "solana") return "https://solscan.io/account/" + a;
  if (n === "ton") return "https://tonscan.org/address/" + a;
  if (n === "bitcoin") return "https://blockstream.info/address/" + a;

  return null;
}

function unifyOnChainNetworks(onChainData, input) {
  try {
    if (!onChainData || !Array.isArray(onChainData.networks)) return onChainData;

    const addrRaw = String(input || "").trim();
    const addrNorm = normalizeAddressForExplorer(addrRaw);

    onChainData.networks = onChainData.networks.map(function (net) {
      if (!net || typeof net !== "object") return net;

      const netName = (net.network || net.chain || net.name || "");
      const n = String(netName).toLowerCase();

      const out = Object.assign({}, net);

      out.address = addrRaw;
      out.addressNormalized = addrNorm;
      if (!out.explorerUrl) out.explorerUrl = buildExplorerUrl(n, out.addressNormalized, out);

      const tx = Number(out.txCount || out.txsChecked || 0);

      let hasBal = false;
      try {
        if (out.balanceWei !== undefined && out.balanceWei !== null) {
          if (BigInt(String(out.balanceWei)) > 0n) hasBal = true;
        }
      } catch (_) {}

      if (!hasBal) {
        const b = Number(out.balance || 0);
        if (isFinite(b) && b > 0) hasBal = true;
      }

      if (!hasBal) {
        const db = String(out.displayBalance || "").trim();
        if (db && db !== "0" && db !== "0.0" && db !== "0.00") hasBal = true;
      }

      // Status unification
      if (out.noHistory) {
        out.status = "inactive";
        if (!out.inactiveReason) out.inactiveReason = "Address has no on-chain history.";
        out.error = null;
      } else {
        if (tx > 0 || hasBal || out.isContract || out.isTokenContract) {
          out.status = "active";
          out.noHistory = false;
          out.inactiveReason = null;
        } else if (!out.status || out.status === "unknown" || out.status === "inactive") {
          out.status = "empty";
        }
      }

      return out;
    });

    if (!onChainData.type) {
      onChainData.type = (onChainData.networks || []).some(function (n) {
        return n && (n.isContract || n.isTokenContract);
      }) ? "contract" : "wallet";
    }

    return onChainData;
  } catch (e) {
    return onChainData;
  }
}
// SCAMSCAN_ONCHAIN_UNIFY_END


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
            if (res.honeypotCheck.flags.includes('SELL_ROUTE_SIMULATION_FAILED')) {
                score = Math.max(score, 75);
                warnings.push(`[${netName}] Sell-route simulation failed (potential sell restriction or trading gate).`);
            }
            if (res.honeypotCheck.flags.includes('APPROVE_SIMULATION_FAILED')) {
                score = Math.max(score, 55);
                warnings.push(`[${netName}] Approve simulation failed (review allowance or transfer logic before interacting).`);
            }
        }

        try {
            if (res.isContract && res.contractControl) {
                const cc = res.contractControl;
                const selectors = Object.assign({}, (cc.selectors || {}), (((cc.sourceCode || {}).abiFeatures || {}).selectors || {}));
                const indicators = Object.assign({}, ((cc.sourceCode || {}).sourceIndicators || {}));
                const has = (key) => !!selectors[key] || !!indicators[key];

                const hasBlacklist = has('blacklist');
                const hasTrading = has('tradingControl');
                const hasWhitelist = has('whitelist');
                const hasFeeConfig = has('feeConfig') || has('setFee');
                const hasRouterControl = has('routerControl');
                const hasWalletLimits = has('walletLimits');
                const hasCooldown = has('cooldown');
                const hasRescue = has('rescue');
                const hasMint = has('mint');
                const hasApprovalControl = has('approvalControl');
                const hasOwner = !!cc.ownerAddress;
                const sourceVerified = !!(((cc.sourceCode || {}).checked) && ((cc.sourceCode || {}).verified));
                const recentEvents = (cc.recentEvents && typeof cc.recentEvents === 'object') ? cc.recentEvents : null;
                const roleAccess = (cc.sourceCode && cc.sourceCode.roleAccess && typeof cc.sourceCode.roleAccess === 'object') ? cc.sourceCode.roleAccess : null;
                const implRoleAccess = (cc.implementationControl && cc.implementationControl.sourceCode && cc.implementationControl.sourceCode.roleAccess && typeof cc.implementationControl.sourceCode.roleAccess === 'object')
                    ? cc.implementationControl.sourceCode.roleAccess
                    : null;
                const roleIds = new Set(
                    []
                      .concat(Array.isArray(roleAccess && roleAccess.roles) ? roleAccess.roles.map((role) => String(role && role.id || '')) : [])
                      .concat(Array.isArray(implRoleAccess && implRoleAccess.roles) ? implRoleAccess.roles.map((role) => String(role && role.id || '')) : [])
                      .filter(Boolean)
                );
                const hasRole = (id) => roleIds.has(String(id || ''));
                const hasRoleAdminFlow = !!(
                    (roleAccess && roleAccess.adminFunctions && (roleAccess.adminFunctions.grantRole || roleAccess.adminFunctions.revokeRole)) ||
                    (implRoleAccess && implRoleAccess.adminFunctions && (implRoleAccess.adminFunctions.grantRole || implRoleAccess.adminFunctions.revokeRole))
                );

                if (hasBlacklist && hasTrading) {
                    score = Math.max(score, 72);
                    warnings.push(`[${netName}] Contract exposes both blacklist controls and trading gates; funds can become hard to sell for selected addresses.`);
                } else if (hasBlacklist && hasWhitelist) {
                    score = Math.max(score, 68);
                    warnings.push(`[${netName}] Contract exposes blacklist and whitelist controls; address-level transfer restrictions may be enforced manually.`);
                } else if (hasTrading && hasFeeConfig) {
                    score = Math.max(score, 62);
                    warnings.push(`[${netName}] Contract exposes trading gates plus owner-controlled tax/fee settings.`);
                }

                if (hasRescue && (hasOwner || hasRouterControl)) {
                    score = Math.max(score, 65);
                    warnings.push(`[${netName}] Rescue/withdraw functions are exposed together with privileged controls; review how assets can be moved by admins.`);
                }

                if (res.honeypotCheck && Array.isArray(res.honeypotCheck.flags) && res.honeypotCheck.flags.includes('APPROVE_SIMULATION_FAILED') && (hasBlacklist || hasTrading || hasWhitelist)) {
                    score = Math.max(score, 74);
                    warnings.push(`[${netName}] Approval path behaved non-standardly while address-gating controls are present; spender approvals may be restricted or selectively handled.`);
                }

                if (hasRouterControl && (hasTrading || hasFeeConfig || hasBlacklist)) {
                    score = Math.max(score, 66);
                    warnings.push(`[${netName}] Router or market-pair controls are exposed together with privileged trading logic; sell path behavior can be changed after launch.`);
                }

                if (hasApprovalControl && (hasRouterControl || hasRescue || hasBlacklist || hasWhitelist)) {
                    score = Math.max(score, 63);
                    warnings.push(`[${netName}] Approval or permit-style controls exist alongside privileged routing/gating logic; review spender and allowance flows before interacting.`);
                }

                if (hasWalletLimits && hasCooldown && (hasTrading || hasBlacklist)) {
                    score = Math.max(score, 60);
                    warnings.push(`[${netName}] Contract combines wallet limits/cooldown with trading controls; this can be used to throttle or block exits.`);
                }

                if (!sourceVerified && (hasBlacklist || hasTrading || hasRescue || hasFeeConfig)) {
                    score = Math.max(score, 70);
                    warnings.push(`[${netName}] Sensitive admin controls are present but verified source is unavailable; this path needs extra caution.`);
                }

                if (hasMint && (hasOwner || hasFeeConfig || hasTrading)) {
                    score = Math.max(score, 58);
                    warnings.push(`[${netName}] Mint capability exists alongside privileged controls; supply and transfer conditions may be changed after launch.`);
                }

                if (hasRole('default_admin_role') && (hasRole('blacklister_role') || hasRole('pauser_role') || hasRole('upgrader_role') || hasRole('minter_role'))) {
                    score = Math.max(score, 74);
                    warnings.push(`[${netName}] AccessControl-style admin roles can reassign high-impact powers such as blacklist, pause, mint, or upgrade.`);
                }

                if (hasRoleAdminFlow && (hasRole('blacklister_role') || hasRole('pauser_role') || hasRole('upgrader_role'))) {
                    score = Math.max(score, 71);
                    warnings.push(`[${netName}] grantRole/revokeRole flows can reassign freeze, pause, or upgrade privileges after launch.`);
                }

                if (hasRole('upgrader_role') || hasRole('default_admin_role') && cc.proxy && cc.proxy.detected) {
                    score = Math.max(score, 69);
                    warnings.push(`[${netName}] Upgrade power appears role-gated, so implementation trust is shared beyond a simple owner path.`);
                }

                if (implRoleAccess && implRoleAccess.usesAccessControl && !(roleAccess && roleAccess.usesAccessControl)) {
                    score = Math.max(score, 72);
                    warnings.push(`[${netName}] Additional privileged roles only appear after following the implementation contract.`);
                }

                if (recentEvents && recentEvents.hasUpgradeHistory && (hasTrading || hasBlacklist || hasFeeConfig || (cc.proxy && cc.proxy.detected))) {
                    score = Math.max(score, 73);
                    warnings.push(`[${netName}] Recent upgrade/admin-change events were observed on-chain while privileged controls are present.`);
                }

                if (recentEvents && recentEvents.hasRoleHistory && hasRoleAdminFlow) {
                    score = Math.max(score, 70);
                    warnings.push(`[${netName}] Recent role grant/revoke events were observed on-chain; privileged role changes are not just theoretical.`);
                }

                if (recentEvents && recentEvents.hasPauseHistory && (hasTrading || hasBlacklist || hasWalletLimits)) {
                    score = Math.max(score, 64);
                    warnings.push(`[${netName}] Pause/unpause governance activity was observed on-chain together with restrictive controls.`);
                }

                if (recentEvents && recentEvents.hasOwnershipHistory && (hasBlacklist || hasTrading || hasFeeConfig || hasMint)) {
                    score = Math.max(score, 58);
                    warnings.push(`[${netName}] Ownership transfer history exists alongside sensitive admin controls; governance assumptions may have changed over time.`);
                }
            }
        } catch (_) {}

            // 1.5 HOLDER CONCENTRATION (token contracts)
    try {
      if (res && res.isTokenContract && res.tokenHolders) {
        const top1 = Number(res.tokenHolders.top1Pct);
        const top5 = Number(res.tokenHolders.top5Pct);
        const holderCount = Number(res.tokenHolders.holderCount);

        if (isFinite(top1)) {
          if (top1 >= 50) {
            score = Math.max(score, 65);
            warnings.push('[' + netName + '] High holder concentration: top holder controls ' + top1.toFixed(2) + '% of supply.');
          } else if (top1 >= 20) {
            score = Math.max(score, 40);
            warnings.push('[' + netName + '] Holder concentration: top holder controls ' + top1.toFixed(2) + '% of supply.');
          }
        }

        if (isFinite(top5) && top5 >= 80) {
          score = Math.max(score, 60);
          warnings.push('[' + netName + '] High concentration: top-5 holders control ' + top5.toFixed(2) + '% of supply.');
        }

        if (isFinite(holderCount) && holderCount > 0) {
          if (holderCount < 25) {
            score = Math.max(score, 55);
            warnings.push('[' + netName + '] Very low holder count: only ' + holderCount + ' holders were reported.');
          } else if (holderCount < 100) {
            score = Math.max(score, 35);
            warnings.push('[' + netName + '] Low holder count: only ' + holderCount + ' holders were reported.');
          }
        }
      }
    } catch (_) {}

    try {
      if (res && res.isTokenContract && res.liquiditySummary) {
        const liq = res.liquiditySummary;
        const liquidityUsd = Number(liq.liquidityUsd);
        const marketCap = Number(liq.marketCap);
        const hasLiquidity = !!liq.found;
        const top1 = Number(res.tokenHolders && res.tokenHolders.top1Pct);
        const hasAdminGating = !!(res.contractControl && res.contractControl.selectors && (
          res.contractControl.selectors.blacklist ||
          res.contractControl.selectors.tradingControl ||
          res.contractControl.selectors.walletLimits ||
          res.contractControl.selectors.cooldown ||
          res.contractControl.selectors.routerControl
        ));

        if (!hasLiquidity && hasAdminGating) {
          score = Math.max(score, 58);
          warnings.push('[' + netName + '] No live DEX liquidity was confirmed while admin trading controls are present.');
        }

        if (Number.isFinite(liquidityUsd) && liquidityUsd > 0) {
          if (liquidityUsd < 5000) {
            score = Math.max(score, 68);
            warnings.push('[' + netName + '] Very thin DEX liquidity: about $' + Math.round(liquidityUsd).toLocaleString('en-US') + '.');
          } else if (liquidityUsd < 25000) {
            score = Math.max(score, 48);
            warnings.push('[' + netName + '] Thin DEX liquidity: about $' + Math.round(liquidityUsd).toLocaleString('en-US') + '.');
          }
        }

        if (Number.isFinite(liquidityUsd) && liquidityUsd > 0 && Number.isFinite(marketCap) && marketCap > 0) {
          const depthRatio = liquidityUsd / marketCap;
          if (depthRatio < 0.005) {
            score = Math.max(score, 65);
            warnings.push('[' + netName + '] Liquidity is extremely shallow relative to reported market cap.');
          } else if (depthRatio < 0.01) {
            score = Math.max(score, 50);
            warnings.push('[' + netName + '] Liquidity is shallow relative to reported market cap.');
          }
        }

        if (Number.isFinite(top1) && top1 >= 50 && Number.isFinite(liquidityUsd) && liquidityUsd > 0 && liquidityUsd < 25000) {
          score = Math.max(score, 72);
          warnings.push('[' + netName + '] High holder concentration is combined with thin liquidity, which increases exit and manipulation risk.');
        }
      }
    } catch (_) {}


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
        // SCAMSCAN_SOLANA_AUTHORITY_SIGNALS
        // Solana SPL Mint authorities (info only)
        if (String(netName).toLowerCase() === "solana" && res.tokenMeta) {
            res.scamSignals = res.scamSignals || [];
            if (res.tokenMeta.mintAuthority) res.scamSignals.push("INFO: Token mint authority is set (supply can be increased).");
            if (res.tokenMeta.freezeAuthority) res.scamSignals.push("INFO: Token freeze authority is set (balances can be frozen).");
        }

        if (res.scamSignals && res.scamSignals.length > 0) {
             res.scamSignals.forEach(sig => {
                 if (!sig) return;
                 const lower = sig.toLowerCase();
                 warnings.push(`[${netName}] ${sig}`);
                 // SCAMSCAN_IGNORE_INFO_SCORE
                 if (lower.startsWith('info:')) return;

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
  if (String(input || '').trim() === '11111111111111111111111111111111') {
    basicInfo.detectedChain = 'solana-like';
  }
  // AUTO: FORCE_TONLIKE_INPUT_START
  {
    const __ton_inp = String(input || "").trim();
    if (/^(EQ|UQ)[A-Za-z0-9_-]{30,}$/.test(__ton_inp) || /^-?\d+:[0-9a-fA-F]{64}$/.test(__ton_inp)) {
      basicInfo.detectedChain = "ton-like";
    }
  }
  // AUTO: FORCE_TONLIKE_INPUT_END

    let risk = basicInfo.risk || 'low';

    // AUTO_TON_RAW_DETECT_V1
    (function(){
      const __t = String(input || "").trim();
      if (__t && (/^(EQ|UQ)[A-Za-z0-9_-]{30,}$/.test(__t) || /^-?\d+:[0-9a-fA-F]{64}$/.test(__t))) {
        basicInfo.detectedChain = "ton-like";
      }
    })();

    let chain = basicInfo.detectedChain;
    // SCAMSCAN_TON_FORCE_BEGIN
    var _ton_inp = String(input || "").trim();
    const _isTon =
        /^(EQ|UQ)[A-Za-z0-9_-]{30,}$/.test(_ton_inp) ||
        /^-?\d+:[0-9a-fA-F]{64}$/.test(_ton_inp);
    if (_isTon) {
        chain = "ton-like";
        basicInfo.detectedChain = "ton-like";
        basicInfo.detectedNetwork = "ton";
    }
    // SCAMSCAN_TON_FORCE_END
    var _ton_inp = String(input||"").trim();
    // TON friendly (EQ/UQ...) OR TON raw (workchain:hex)
    if (/^(EQ|UQ)[A-Za-z0-9_\-]{30,}$/.test(_ton_inp) || /^-?\d+:[0-9a-fA-F]{64}$/.test(_ton_inp)) {
      chain = "ton-like";
    }
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
        let networksToCheck = ['ethereum', 'bsc', 'base'];
        const scanPromises = networksToCheck.map(async (net) => {
            try {
                const basicScan = await scanNetwork(net, input);
                if (basicScan.error) return { network: net, error: basicScan.error };

                let contractControl = await getContractControl(net, input, { maxDepth: 1 });
                const hpCheck = await checkHoneypot(net, input);
                let isContract = !!(hpCheck && hpCheck.isContract);
                if (!isContract && contractControl) {
                    isContract = true;
                }
                let tokenMeta = null;
                if (isContract) tokenMeta = await getTokenMetaViaRpc(net, input);
                let holderSummary = null;
                if (isContract) {
                    holderSummary = await fetchExplorerHolderSummary(net, input, tokenMeta).catch(() => null);
                }
                let liquiditySummary = null;
                if (isContract) {
                    liquiditySummary = await fetchDexLiquiditySummary(net, input).catch(() => null);
                }
                let tradingSimulation = null;
                if (isContract) {
                    tradingSimulation = await simulateTradingPaths(net, input, {
                        pairAddress: liquiditySummary && liquiditySummary.pairAddress,
                        contractControl
                    }).catch(() => null);
                }
                const mergedHpCheck = (() => {
                    if (!hpCheck && !tradingSimulation) return null;
                    const baseHp = (hpCheck && hpCheck.isContract)
                        ? hpCheck
                        : { isContract: true, codeSize: 0, isHoneypot: false, flags: [] };
                    const sim = tradingSimulation || {};
                    let mergedFlags = Array.from(new Set([].concat(baseHp.flags || [], sim.flags || [])));
                    if (sim && sim.probes && sim.probes.transfer && sim.probes.transfer.ok) {
                        mergedFlags = mergedFlags.filter((flag) => flag !== 'TRANSFER_SIMULATION_FAILED');
                    }
                    if (sim && sim.probes && sim.probes.approve && sim.probes.approve.ok) {
                        mergedFlags = mergedFlags.filter((flag) => flag !== 'APPROVE_SIMULATION_FAILED');
                    }
                    if (sim && sim.probes && sim.probes.sellRoute && sim.probes.sellRoute.ok) {
                        mergedFlags = mergedFlags.filter((flag) => flag !== 'SELL_ROUTE_SIMULATION_FAILED');
                    }
                    return Object.assign({}, baseHp, sim, {
                        isContract: true,
                        isHoneypot: !!((baseHp && baseHp.isHoneypot) || sim.isHoneypot),
                        flags: mergedFlags,
                        warnings: Array.from(new Set([].concat(baseHp.warnings || [], sim.warnings || []))),
                        probes: Object.assign({}, baseHp.probes || {}, sim.probes || {}),
                        riskScore: Math.max(Number(baseHp.riskScore || 0), Number(sim.riskScore || 0))
                    });
                })();

                if (basicScan.txCount === 0 && BigInt(basicScan.balanceWei) === 0n && !isContract) {
                     return { ...basicScan, status: 'empty', nativeCurrency: NATIVE_CURRENCIES[net] };
                }

                if (contractControl) {
                    if (contractControl.ownerAddress) {
                        basicScan.scamSignals = basicScan.scamSignals || [];
                        basicScan.scamSignals.push("INFO: Contract owner address is set.");
                    }
                    if (contractControl.paused === true) {
                        basicScan.scamSignals = basicScan.scamSignals || [];
                        basicScan.scamSignals.push("INFO: Contract is currently paused.");
                    }
                    if (contractControl.proxy && contractControl.proxy.detected) {
                        basicScan.scamSignals = basicScan.scamSignals || [];
                        basicScan.scamSignals.push("INFO: Proxy or upgrade slot was detected.");
                    }
                    if (contractControl.selectors && contractControl.selectors.mint) {
                        basicScan.scamSignals = basicScan.scamSignals || [];
                        basicScan.scamSignals.push("INFO: Mint-related selector is present in bytecode.");
                    }
                    if (contractControl.selectors && contractControl.selectors.blacklist) {
                        basicScan.scamSignals = basicScan.scamSignals || [];
                        basicScan.scamSignals.push("INFO: Blacklist-related selector is present in bytecode.");
                    }
                }

                return {
                    network: net,
                    balanceWei: basicScan.balanceWei,
                    balance: formatBalance(basicScan.balanceWei, NATIVE_CURRENCIES[net].decimals),
                    txCount: basicScan.txCount,
                    isContract: !!isContract,
                    tokenMeta: tokenMeta,
                    tokenHolders: holderSummary,
                    liquiditySummary: liquiditySummary,
                    contractControl: contractControl,
                    nativeCurrency: NATIVE_CURRENCIES[net],
                    honeypotCheck: mergedHpCheck,
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
    onChainData = unifyOnChainNetworks(onChainData, input);        // SCAMSCAN_ONCHAIN_GUARD_BEGIN
    if (!onChainData || typeof onChainData !== "object") onChainData = { provider: "unknown", networks: [] };
    if (!Array.isArray(onChainData.networks)) onChainData.networks = [];

    // IMPORTANT: for TON-like we must always have at least one network entry,
    // otherwise frontend/smoke will fail on "ton network missing"
    if (chain === "ton-like" && onChainData.networks.length === 0) {
        if (!onChainData.provider || onChainData.provider === "unknown") onChainData.provider = "ton";
        onChainData.networks.push({
            network: "ton",
            status: "unknown",
            error: onChainData.error || null
        });
    }
    // SCAMSCAN_ONCHAIN_GUARD_END




    const riskAnalysis = evaluateRisk(input, chain, onChainData.networks || []);

    try {
        const preferredNet = Array.isArray(onChainData.networks)
            ? (onChainData.networks.find(function (n) { return n && n.isContract; }) ||
               onChainData.networks.find(function (n) { return n && n.status === 'active'; }) ||
               onChainData.networks[0])
            : null;
        if (preferredNet && preferredNet.network) {
            chain = String(preferredNet.network);
        }
    } catch (_) {}

    let finalScore = riskAnalysis.score;

    // VERDICT MAPPING (CALIBRATED)
    if (finalScore >= 80) risk = 'critical';       // SCAM
    else if (finalScore >= 60) risk = 'high';      // DANGEROUS
    else if (finalScore >= 35) risk = 'medium';    // CAUTION (Fresh wallets fall here)
    else risk = 'low';                             // SAFE

    // Normalize "no history" across networks: do NOT scare users with "Network error"
    if (onChainData && Array.isArray(onChainData.networks)) {
        onChainData.networks = onChainData.networks.map(function (n) {
            try {
                var err = (n && n.error) ? String(n.error) : "";
                if (err && /(account does not exist|not found|unknown account|no such account)/i.test(err)) {
                    return Object.assign({}, n, {
                        status: "inactive",
                        noHistory: true,
                        inactiveReason: "Address has no on-chain history.",
                        error: null
                    });
                }
            } catch (e) {}
            return n;
        });
    }

    // Override verdict text for clarity
    let verdictText = 'SAFE';
    if (risk === 'critical') verdictText = 'SCAM';
    if (risk === 'high') verdictText = 'HIGH RISK';
    if (risk === 'medium') verdictText = 'SUSPICIOUS'; // Or CAUTION

    return {
        chain,
        risk,
        riskScore: finalScore,
        verdict: verdictText, // Explicit verdict field
        warnings: [...new Set(riskAnalysis.warnings)],
        onChain: onChainData
    };
}

module.exports = { analyzeWallet };
