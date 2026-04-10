const axios = require('axios');

const BLOCKSTREAM_BASE = 'https://blockstream.info/api';

async function fetchBtcAddress(address) {
  const resp = await axios.get(`${BLOCKSTREAM_BASE}/address/${address}`, {
    timeout: 7000
  });
  return resp.data;
}

async function analyzeBtcAddressOnChain(address) {
  const net = {
    network: 'Bitcoin',
    api: `${BLOCKSTREAM_BASE}/address`,
    txsChecked: 0,
    scamSignals: [],
    error: null,
    status: 'inactive',
    balance: 0,
    nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 8 },
    balanceFormatted: '0',
    displayBalance: '0',
    txCount: 0,
    totalReceived: 0,
    totalSent: 0
  };

  let risk = 'low';

  try {
    const data = await fetchBtcAddress(address);
    const chain = data.chain_stats || {};
    const mempool = data.mempool_stats || {};

    const funded = Number(chain.funded_txo_sum || 0);
    const spent = Number(chain.spent_txo_sum || 0);
    const txCount = Number(chain.tx_count || 0) + Number(mempool.tx_count || 0);
    const balance = funded - spent;

    net.balance = balance;
    net.balanceFormatted = (balance / 1e8).toString();
    net.displayBalance = (balance / 1e8).toString();
    net.txCount = txCount;
    net.txsChecked = txCount;

    net.totalReceived = funded;
    net.totalSent = spent;

    const receivedBtc = funded / 1e8;
    const sentBtc = spent / 1e8;

    net.status = txCount > 0 ? 'active' : 'empty';

    // Risk / warning heuristics
    if (txCount === 0 && balance === 0) {
      risk = 'low';
    } else {
      if (txCount < 5) {
        net.scamSignals.push('Very fresh address with small historical activity.');
      }
      if (balance === 0 && txCount > 0) {
        net.scamSignals.push('Zero current balance — all funds moved out.');
      }
    }

    // Always add a human-readable flow summary if there was any activity
    if (txCount > 0) {
      const flowSummary = `Total received: ${receivedBtc} BTC • Total sent: ${sentBtc} BTC • Net balance: ${balance / 1e8} BTC`;
      net.scamSignals.push(flowSummary);
    }

  } catch (err) {
    net.error = err.message || String(err);
  }

  return {
    risk,
    warnings: net.scamSignals.filter(Boolean),
    onChain: {
      provider: 'blockstream',
      enabled: true,
      networks: [net]
    }
  };
}

module.exports = { analyzeBtcAddressOnChain };
