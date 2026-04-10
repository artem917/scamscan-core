const axios = require('axios');


const { fetchTrc20MetaByCalls } = require("./tronTrc20Meta");
const TRON_API_BASE = 'https://api.trongrid.io';

// SCAMSCAN_TRON_EXPLORER_BEGIN
function tronscanUrl(address, isContract) {
  const a = String(address || '').trim();
  if (!a) return null;
  return isContract ? ('https://tronscan.org/#/contract/' + a) : ('https://tronscan.org/#/address/' + a);
}
// SCAMSCAN_TRON_EXPLORER_END


function formatUnitsBigInt(total, decimals) {
  try {
    if (total === null || typeof total === "undefined") return null;
    const s = String(total).trim();
    if (!/^\d+$/.test(s)) return s;
    if (typeof decimals !== "number" || !isFinite(decimals) || decimals < 0) return s;
    const bi = BigInt(s);
    const base = 10n ** BigInt(decimals);
    const i = bi / base;
    const f = bi % base;
    if (decimals === 0) return i.toString();
    let fs = f.toString().padStart(decimals, "0").replace(/0+$/, "");
    return fs ? (i.toString() + "." + fs) : i.toString();
  } catch (e) {
    return String(total);
  }
}

function buildTronHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const key = process.env.TRONGRID_API_KEY;
  if (key) {
    headers['TRON-PRO-API-KEY'] = key;
  }
  return headers;
}

// Базовая инфа по аккаунту (в т.ч. type: "Contract" / "Normal")
async function fetchTronAccount(address) {
  try {
    const resp = await axios.get(`${TRON_API_BASE}/v1/accounts/${address}`, {
      headers: buildTronHeaders(),
      timeout: 5000
    });
    const data = resp.data && resp.data.data;
    if (Array.isArray(data) && data.length > 0) {
      return data[0];
    }
    return null;
  } catch (e) {
    throw new Error(`Tron account error: ${e.message}`);
  }
}

// Простейший txCount по последним транзам
async function fetchTronAccountTxCount(address) {
  try {
    const resp = await axios.get(`${TRON_API_BASE}/v1/accounts/${address}/transactions`, {
      headers: buildTronHeaders(),
      params: { limit: 20, only_confirmed: true },
      timeout: 5000
    });
    const data = resp.data && resp.data.data;
    if (Array.isArray(data)) return data.length;
    return 0;
  } catch (e) {
    // Не критично
    return 0;
  }
}

// Базовая инфа по контракту (bytecode, type и т.п.)
async function fetchTronContract(address) {
  try {
    const resp = await axios.get(`${TRON_API_BASE}/v1/contracts/${address}`, {
      headers: buildTronHeaders(),
      timeout: 5000,
      validateStatus: (s) => (s === 200 || s === 404)
    });
    if (resp.status === 404) return null;
    const data = resp.data && resp.data.data;
    if (Array.isArray(data) && data.length > 0) {
      return data[0];
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Пытаемся вытащить TRC20-инфу: holders + token_info
async function fetchTrc20TokenInfo(address) {
  try {
    const resp = await axios.get(`${TRON_API_BASE}/v1/contracts/${address}/tokens`, {
      headers: buildTronHeaders(),
      timeout: 5000,
      validateStatus: (s) => (s === 200 || s === 404)
    });
    if (resp.status === 404) return null;
    const data = resp.data && resp.data.data;
    if (!Array.isArray(data) || data.length === 0) return null;

    // TronGrid обычно кладёт token_info в элементы массива
    const first = data[0];
    const info = first && first.token_info ? first.token_info : null;

    return {
      raw: data,
      tokenInfo: info || null
    };
  } catch (e) {
    return null;
  }
}

// Очень простая эвристика TRC20 по ABI / названию методов,
// если вдруг TronGrid всё-таки вернёт ABI
function detectTrc20FromAbi(contract) {
  try {
    const abi = contract && contract.abi && contract.abi.entrys;
    if (!Array.isArray(abi)) return { isTokenContract: false, tokenStandard: null };

    const names = abi
      .filter((e) => e && e.type === 'function' && e.name)
      .map((e) => e.name.toLowerCase());

    const required = ['totalsupply', 'balanceof', 'transfer'];
    const hasCore = required.every((n) => names.includes(n));

    if (hasCore) {
      return { isTokenContract: true, tokenStandard: 'TRC20' };
    }

    return { isTokenContract: false, tokenStandard: null };
  } catch (_) {
    return { isTokenContract: false, tokenStandard: null };
  }
}

async function analyzeTronAddressOnChain(address) {
  const net = {
    network: 'TRON',
    api: TRON_API_BASE,
    address: address,
    addressNormalized: String(address || '').trim(),
    explorerUrl: tronscanUrl(address, false),
    txsChecked: 0,
    scamSignals: [],
    error: null,
    noHistory: false,
    inactiveReason: null,
    status: 'inactive',
    balance: 0,
    nativeCurrency: { name: 'TRON', symbol: 'TRX', decimals: 6 },
    isContract: false,
    isTokenContract: false,
    tokenStandard: null
  };

  let risk = 'low';

  try {
    let account = null;

    // 1. Account info (type + баланс)
    try {
      account = await fetchTronAccount(address);
      if (account) {
        net.status = 'active';
        if (typeof account.balance === 'number') {
          net.balance = account.balance; // sun
        }

        // Главное место: type: "Contract" => это контракт
        // Примеры: "Contract", "Normal", "AssetIssueContract" и т.п.
        if (account.type && typeof account.type === 'string') {
          if (account.type.toLowerCase() === 'contract') {
            net.isContract = true;
            net.contractAccountType = account.type;
            net.explorerUrl = tronscanUrl(address, true);
          } else {
            net.contractAccountType = account.type;
          }
        }
      } else {
        net.noHistory = true;
        net.status = 'inactive';
        net.inactiveReason = 'Address has no on-chain history.';
        net.explorerUrl = tronscanUrl(address, false);
      }
    } catch (e) {
      net.error = e.message;
    }

    // 2. Доп. инфа по контракту (если выглядит как контракт)
    // Даже если account.type не говорит "Contract", всё равно попробуем —
    // TronGrid иногда косячит.
    let contractMeta = null;
    try {
      contractMeta = await fetchTronContract(address);
      if (contractMeta) {
        // If we can fetch contract metadata, treat it as a contract even if account endpoint was empty
        net.isContract = true;
        net.status = 'active';
        net.noHistory = false;
        net.inactiveReason = null;
        net.explorerUrl = tronscanUrl(address, true);
        // Если раньше не показали isContract — выставим здесь
        if (!net.isContract) {
          net.isContract = true;
        }
        if (contractMeta.type) {
          net.contractType = contractMeta.type;
        }
        // Попытка определить TRC20 по ABI
        const fromAbi = detectTrc20FromAbi(contractMeta);
        if (fromAbi.isTokenContract) {
          net.isTokenContract = true;
          net.tokenStandard = fromAbi.tokenStandard;
        }
      }
    } catch (e) {
      if (net.error) net.error += `; Contract meta error: ${e.message}`;
      else net.error = `Contract meta error: ${e.message}`;
    }

    // 3. TRC20-холдеры / token_info (надёжный признак TRC20)
    try {
      let trc20 = await fetchTrc20TokenInfo(address);
        if (!trc20) {
          try { await new Promise(r => setTimeout(r, 1500)); } catch (_) {}
          trc20 = await fetchTrc20TokenInfo(address);
        }
if (trc20) {
        net.status = 'active';
        net.noHistory = false;
        net.inactiveReason = null;
        net.explorerUrl = tronscanUrl(address, true);
        net.isTokenContract = true;
        if (!net.tokenStandard) net.tokenStandard = 'TRC20';

        // SCAMSCAN_TRC20_META_V1
        try {
          if (net.tokenMeta === null || typeof net.tokenMeta === "undefined") {
            const meta = await fetchTrc20MetaByCalls(address, buildTronHeaders(), formatUnitsBigInt);
            if (meta) net.tokenMeta = meta;
          }
        } catch (_) {}



          // SCAMSCAN_TRC20_HOLDER_CONCENTRATION_V2_BEGIN
          try {
            const raw = (trc20 && Array.isArray(trc20.raw)) ? trc20.raw
                      : (trc20 && Array.isArray(trc20.data)) ? trc20.data
                      : [];

            const holders = [];
            for (const row of raw) {
              if (!row || typeof row !== "object") continue;
              for (const kv of Object.entries(row)) {
                const k = kv[0];
                const v = kv[1];
                if (!k) continue;
                if (k === "token_info" || k === "tokenInfo" || k === "tokenInfo" || k === "meta") continue;
                try {
                  const amt = BigInt(String(v));
                  holders.push({ address: k, amount: amt });
                } catch (_) {}
                break;
              }
            }

            if (holders.length) {
              holders.sort((a, b) => (a.amount > b.amount ? -1 : (a.amount < b.amount ? 1 : 0)));

              // supply: prefer net.tokenMeta, fallback to tokenInfo-like
              let supplyStr = (net.tokenMeta && net.tokenMeta.totalSupply) ? String(net.tokenMeta.totalSupply) : null;
              if (!supplyStr) {
                const ti = trc20 ? (trc20.tokenInfo || trc20.token_info || trc20.token || null) : null;
                supplyStr = ti ? String(ti.total_supply || ti.totalSupply || ti.supply || "") : null;
                if (supplyStr && !supplyStr.trim()) supplyStr = null;
              }

              let supply = null;
              try { if (supplyStr) supply = BigInt(String(supplyStr)); } catch (_) { supply = null; }

              const sumTop = (n) => {
                let s = 0n;
                for (let i = 0; i < holders.length && i < n; i++) s += holders[i].amount;
                return s;
              };

              const top1 = holders[0].amount;
              const top5 = sumTop(5);
              const top10 = sumTop(10);

              const out = {
                sampleSize: holders.length,
                topHolder: holders[0].address,
                top1Raw: top1.toString(),
                top5Raw: top5.toString(),
                top10Raw: top10.toString()
              };

              if (supply && supply > 0n) {
                const pct2 = (x) => Number((x * 10000n) / supply) / 100;
                out.top1Pct = pct2(top1);
                out.top5Pct = pct2(top5);
                out.top10Pct = pct2(top10);
              }

              net.tokenHolders = out;
            }
          } catch (_) {}
          // SCAMSCAN_TRC20_HOLDER_CONCENTRATION_V2_END

        // Attach TRC20 metadata for UI (best-effort from multiple sources)
        try {
          let src = null;
          if (trc20 && trc20.tokenInfo) src = trc20.tokenInfo;
          else if (typeof contractMeta !== "undefined" && contractMeta) src = (contractMeta.tokenInfo || contractMeta.token_info || contractMeta.trc20 || contractMeta);
          if (src && !net.tokenMeta) {
            const d = (src.decimals !== undefined && src.decimals !== null) ? Number(src.decimals) : null;
            const ts = (src.total_supply || src.totalSupply || src.supply || src.totalSupplyWithDecimals || null);
            net.tokenMeta = {
              name: src.name || src.token_name || null,
              symbol: src.symbol || src.token_symbol || null,
              decimals: (d !== null && isFinite(d)) ? d : null,
              totalSupply: ts ? String(ts) : null,
              totalSupplyFormatted: (ts && d !== null && isFinite(d)) ? formatUnitsBigInt(String(ts), d) : undefined
            };
          }
        } catch (e) {}

        if (trc20.tokenInfo) {
          const d = (trc20.tokenInfo.decimals !== undefined && trc20.tokenInfo.decimals !== null) ? Number(trc20.tokenInfo.decimals) : null;
          const ts = (trc20.tokenInfo.total_supply || trc20.tokenInfo.totalSupply || trc20.tokenInfo.supply || null);
          net.tokenMeta = {
            name: trc20.tokenInfo.name || null,
            symbol: trc20.tokenInfo.symbol || null,
            decimals: (d !== null && isFinite(d)) ? d : null,
            totalSupply: ts ? String(ts) : null,
            totalSupplyFormatted: (ts && d !== null && isFinite(d)) ? formatUnitsBigInt(String(ts), d) : undefined
          };
        }      }
    } catch (e) {
      if (net.error) net.error += `; TRC20 detect error: ${e.message}`;
      else net.error = `TRC20 detect error: ${e.message}`;
    }

    // 4. Простейшая активность (txCount)
    try {
      const txCount = await fetchTronAccountTxCount(address);
      net.txsChecked = txCount;
      net.txCount = txCount;
      if (typeof txCount === 'number' && txCount > 0) {
        net.status = 'active';
        net.noHistory = false;
        net.inactiveReason = null;
      } else {
        // If account exists but empty (no balance + no tx) — mark as empty instead of inactive
        if (!net.noHistory) {
          const bal = Number(net.balance || 0);
          if (isFinite(bal) && bal === 0 && !net.isContract && !net.isTokenContract) {
            net.status = 'empty';
          }
        }
      }

    } catch (_) {
      // игнорируем
    }

  } catch (e) {
    net.error = e.message;
  }

  // Final TRON status sanity
  if (net.noHistory) {
    net.status = 'inactive';
    if (!net.inactiveReason) net.inactiveReason = 'Address has no on-chain history.';
    if (!net.explorerUrl) net.explorerUrl = tronscanUrl(address, false);
  }


  return {
    risk,
    warnings: net.scamSignals,
    onChain: {
      provider: 'trongrid',
      enabled: true,
      networks: [net]
    }
  };
}

module.exports = { analyzeTronAddressOnChain };
