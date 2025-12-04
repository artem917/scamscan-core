const axios = require('axios');

const TRON_API_BASE = 'https://api.trongrid.io';

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
    txsChecked: 0,
    scamSignals: [],
    error: null,
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
          } else {
            net.contractAccountType = account.type;
          }
        }
      } else {
        net.error = 'Account does not exist on TRON mainnet.';
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
      const trc20 = await fetchTrc20TokenInfo(address);
      if (trc20) {
        net.isTokenContract = true;
        if (!net.tokenStandard) net.tokenStandard = 'TRC20';
        if (trc20.tokenInfo) {
          net.tokenInfo = {
            name: trc20.tokenInfo.name || null,
            symbol: trc20.tokenInfo.symbol || null,
            decimals: trc20.tokenInfo.decimals
          };
        }
      }
    } catch (e) {
      if (net.error) net.error += `; TRC20 detect error: ${e.message}`;
      else net.error = `TRC20 detect error: ${e.message}`;
    }

    // 4. Простейшая активность (txCount)
    try {
      const txCount = await fetchTronAccountTxCount(address);
      net.txsChecked = txCount;
      net.txCount = txCount;
    } catch (_) {
      // игнорируем
    }

  } catch (e) {
    net.error = e.message;
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
