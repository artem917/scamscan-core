const axios = require('axios');
const { RPC_PROVIDERS } = require('../config/rpc');

// ---------------- ETHERSCAN HISTORY (ETH only) ----------------

async function getEtherscanTransactions(address) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return null;
  try {
    const url =
      `https://api.etherscan.io/api` +
      `?module=account&action=txlist` +
      `&address=${address}` +
      `&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;
    const resp = await axios.get(url, { timeout: 6000 });
    if (resp.data && resp.data.status === '1' && Array.isArray(resp.data.result)) {
      return resp.data.result;
    }
    return [];
  } catch (e) {
    return null;
  }
}

function analyzeTxHistory(txs, address) {
  if (!txs || txs.length === 0) {
    return {
      txCount: 0,
      incoming: 0,
      outgoing: 0,
      uniqueSenders: 0,
      uniqueReceivers: 0,
      signals: []
    };
  }

  const addr = address.toLowerCase();
  let incoming = 0;
  let outgoing = 0;
  const senders = new Set();
  const receivers = new Set();

  for (const tx of txs) {
    const from = (tx.from || '').toLowerCase();
    const to = (tx.to || '').toLowerCase();

    if (to === addr) {
      incoming++;
      if (from) senders.add(from);
    }
    if (from === addr) {
      outgoing++;
      if (to) receivers.add(to);
    }
  }

  const signals = [];
  if (incoming > 0 && outgoing === 0) {
    signals.push('Wallet has only incoming transactions (possible deposit-only).');
  }

  return {
    txCount: txs.length,
    incoming,
    outgoing,
    uniqueSenders: senders.size,
    uniqueReceivers: receivers.size,
    signals
  };
}

// ---------------- GENERIC RPC WITH FALLBACK ----------------

async function callRpcWithFallback(chain, method, params = []) {
  const providers = RPC_PROVIDERS[chain] || [];
  if (!providers.length) {
    throw new Error(`No RPC providers configured for chain: ${chain}`);
  }

  let lastError;
  for (const url of providers) {
    try {
      const resp = await axios.post(
        url,
        { jsonrpc: '2.0', id: 1, method, params },
        { timeout: 10000 }
      );
      if (resp.data && Object.prototype.hasOwnProperty.call(resp.data, 'result')) {
        return resp.data.result;
      }
    } catch (e) {
      lastError = e;
      continue;
    }
  }
  throw lastError || new Error('All RPC providers failed');
}

// Simple wrapper for eth_call
async function ethCallSimulate(chain, to, data) {
  return callRpcWithFallback(chain, 'eth_call', [{ to, data }, 'latest']);
}

function parseStringFromHex(hex) {
  try {
    if (!hex || hex === '0x') return '';
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    let res = '';
    for (let i = 0; i < clean.length; i += 2) {
      const byte = parseInt(clean.substr(i, 2), 16);
      if (Number.isNaN(byte)) continue;
      if (byte >= 32 && byte <= 126) {
        res += String.fromCharCode(byte);
      }
    }
    return res.replace(/[^a-zA-Z0-9 \-\.]/g, '').trim();
  } catch (e) {
    return '';
  }
}

// ---------------- HONEYPOT / CONTRACT CHECK ----------------

async function checkHoneypot(chain, address) {
  try {
    const code = await callRpcWithFallback(chain, 'eth_getCode', [address, 'latest']);

    // Любой "пустой" код (0x, 0x0, 0x0000...) считаем EOA, а не контракт
    if (!code || /^0x0*$/.test(code)) {
      return { isContract: false, codeSize: 0, isHoneypot: false, flags: [] };
    }

    const result = {
      isContract: true,
      codeSize: code.length,
      isHoneypot: false,
      flags: []
    };

    // Проба стандартного ERC20 totalSupply()
    try {
      await ethCallSimulate(chain, address, '0x18160ddd');
    } catch (e) {
      result.flags.push('NOT_STD_ERC20');
    }

    // Проба transfer(to=0xdead, amount=0) — ловим простые honeypot-ограничения
    const method = '0xa9059cbb';
    const toParam = '000000000000000000000000000000000000dead';
    const amountParam = '0000000000000000000000000000000000000000000000000000000000000000';

    try {
      await ethCallSimulate(chain, address, method + toParam + amountParam);
    } catch (e) {
      // v1: simulation error is logged as a flag but не приговаривает контракт к honeypot
      result.flags.push('TRANSFER_SIMULATION_FAILED');
    }

    return result;
  } catch (e) {
    return {
      isContract: false,
      codeSize: 0,
      isHoneypot: false,
      flags: ['RPC_FAIL']
    };
  }
}


// ---------------- TOKEN META VIA RPC ----------------

async function getTokenMetaViaRpc(chain, address) {
  try {
    const [nameHex, symbolHex, decimalsHex, totalSupplyHex] = await Promise.all([
      ethCallSimulate(chain, address, '0x06fdde03').catch(() => null), // name()
      ethCallSimulate(chain, address, '0x95d89b41').catch(() => null), // symbol()
      ethCallSimulate(chain, address, '0x313ce567').catch(() => null), // decimals()
      ethCallSimulate(chain, address, '0x18160ddd').catch(() => null)  // totalSupply()
    ]);

    const rawName = parseStringFromHex(nameHex);
    const rawSymbol = parseStringFromHex(symbolHex);

    // Если оба не прочитались — считаем, что это не токен (или мета недоступна)
    if (!rawName && !rawSymbol) {
      return null;
    }

    const name = rawName || 'Unknown';
    const symbol = rawSymbol || 'TKN';

    let decimals = 18;
    if (decimalsHex && decimalsHex !== '0x') {
      try {
        const clean = decimalsHex.startsWith('0x') ? decimalsHex.slice(2) : decimalsHex;
        if (clean) {
          const decVal = parseInt(clean, 16);
          if (Number.isFinite(decVal) && decVal >= 0 && decVal <= 36) {
            decimals = decVal;
          }
        }
      } catch (e) {
        // оставляем default = 18
      }
    }

    let totalSupply = null;
    let totalSupplyFormatted = null;
    if (totalSupplyHex && totalSupplyHex !== '0x') {
      try {
        const clean = totalSupplyHex.startsWith('0x') ? totalSupplyHex.slice(2) : totalSupplyHex;
        if (clean) {
          const value = BigInt('0x' + clean);
          totalSupply = value.toString();

          if (decimals >= 0 && decimals <= 36) {
            const base = 10n ** BigInt(decimals);
            const whole = value / base;
            const fraction = value % base;
            let fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
            if (fractionStr) {
              fractionStr = fractionStr.slice(0, 6);
              totalSupplyFormatted = whole.toString() + '.' + fractionStr;
            } else {
              totalSupplyFormatted = whole.toString();
            }
          }
        }
      } catch (e) {
        // если что-то пошло не так — оставим totalSupply/null
      }
    }

    return { name, symbol, decimals, totalSupply, totalSupplyFormatted };
  } catch (e) {
    return null;
  }
}

// ---------------- NETWORK SCAN (используется walletService) ----------------

async function scanNetwork(chain, address) {
  const result = {
    chain,
    balanceWei: '0',
    txCount: 0,
    scamSignals: [],
    error: null
  };

  try {
    // История через Etherscan — только для Ethereum
    if (chain === 'ethereum') {
      const txs = await getEtherscanTransactions(address);
      if (txs !== null) {
        const analysis = analyzeTxHistory(txs, address);
        result.txCount = analysis.txCount;
        result.scamSignals = analysis.signals;
      }
    }

    // Баланс через RPC
    const balanceHex = await callRpcWithFallback(chain, 'eth_getBalance', [address, 'latest']);
    if (balanceHex) {
      result.balanceWei = BigInt(balanceHex).toString();
    }

    // Если по истории txCount == 0 — пробуем RPC tx count
    if (result.txCount === 0) {
      const txCountHex = await callRpcWithFallback(chain, 'eth_getTransactionCount', [
        address,
        'latest'
      ]);
      if (txCountHex) {
        result.txCount = parseInt(txCountHex, 16);
      }
    }

    return result;
  } catch (e) {
    return {
      chain,
      balanceWei: '0',
      txCount: 0,
      scamSignals: [],
      error: e.message || 'RPC_ERROR'
    };
  }
}

module.exports = {
  scanNetwork,
  checkHoneypot,
  getTokenMetaViaRpc,
  ethCallSimulate
};
