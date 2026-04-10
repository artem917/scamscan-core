const axios = require('axios');

// SCAMSCAN_SOL_KNOWN_MINTS
const SOL_KNOWN_MINTS = {
  // Stablecoins / majors
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", name: "USD Coin" },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", name: "Tether USD" },
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": { symbol: "JUP", name: "Jupiter" },
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": { symbol: "BONK", name: "Bonk" }
};
// SCAMSCAN_SOL_KNOWN_MINTS_END

async function analyzeSolanaAddressOnChain(address) {
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

  const net = {
    network: 'Solana',
    kind: null, // program | mint | token_account | wallet | unknown
    api: rpcUrl,
    txsChecked: 0,
    scamSignals: [],
    error: null,

    // Unified status fields
    status: 'inactive',       // active | empty | inactive
    noHistory: false,
    inactiveReason: null,

    // balance in lamports (integer)
    balance: 0,
    nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },

    // account / contract hints
    isContract: false,        // Solana "program account" (executable)
    accountExecutable: false,
    owner: null,

    // SPL mint (token contract) best-effort
    isTokenContract: false,
    tokenMeta: null,
  };

  let risk = 'low';

  try {
    // 1) Balance (getBalance returns 0 even for non-existent accounts; do NOT mark active here)
    try {
      const balResp = await axios.post(
        rpcUrl,
        { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] },
        { timeout: 4000 }
      );

      if (balResp.data && balResp.data.result && typeof balResp.data.result.value === 'number') {
        net.balance = balResp.data.result.value; // lamports
      }
    } catch (e) {
      const msg = `Balance RPC error: ${e.message}`;
      net.error = net.error ? `${net.error}; ${msg}` : msg;
    }

    // 2) Account info (detect: exists? executable? SPL mint?)
    try {
      const accResp = await axios.post(
        rpcUrl,
        { jsonrpc: '2.0', id: 2, method: 'getAccountInfo', params: [address, { encoding: 'jsonParsed' }] },
        { timeout: 4000 }
      );

      if (accResp.data && accResp.data.result) {
        const value = accResp.data.result.value;

        if (value) {
          const executable = !!value.executable;
          net.accountExecutable = executable;
          net.isContract = executable;

          
                    // SCAMSCAN_SOL_MINT_DETECT_BEGIN
                    // Detect SPL token mint / token account (jsonParsed best-effort)
                    try {
                        const data = value && value.data;
                        const program = data && data.program;
                        const parsed = data && data.parsed;

                        if (program === 'spl-token' && parsed && parsed.type === 'mint') {
                            net.isTokenContract = true;
                            const info = (parsed.info || {});
                            net.tokenMeta = net.tokenMeta || {};
                            if (info.decimals !== undefined) net.tokenMeta.decimals = info.decimals;
                            if (info.supply !== undefined) net.tokenMeta.totalSupply = info.supply; // keep as string if huge
                            net.tokenMeta.mintAuthority = info.mintAuthority || null;
                            net.tokenMeta.freezeAuthority = info.freezeAuthority || null;
                            // SCAMSCAN_SOL_FORCE_KNOWN_MINTS
                            const __a = String(address || '').trim();
                            if (__a === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
                                if (!net.tokenMeta.symbol) net.tokenMeta.symbol = 'USDC';
                                if (!net.tokenMeta.name) net.tokenMeta.name = 'USD Coin';
                            } else if (__a === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') {
                                if (!net.tokenMeta.symbol) net.tokenMeta.symbol = 'USDT';
                                if (!net.tokenMeta.name) net.tokenMeta.name = 'Tether USD';
                            }
                            // SCAMSCAN_SOL_KNOWN_MINTS_APPLY
                            const known = SOL_KNOWN_MINTS[String(address || '').trim()];
                            if (known) {
                                if (!net.tokenMeta.symbol) net.tokenMeta.symbol = known.symbol;
                                if (!net.tokenMeta.name) net.tokenMeta.name = known.name;
                            }
                        } else if (program === 'spl-token' && parsed && parsed.type === 'account') {
                            // token account (not a mint) — useful hint for UI
                            if (!net.kind) net.kind = 'token_account';
                        }
                    } catch (_) {}
                    // SCAMSCAN_SOL_MINT_DETECT_END
if (value.owner) net.owner = value.owner;

          // SPL token mint best-effort (no name/symbol on-chain in pure RPC)
          try {
            const parsed = value.data && value.data.parsed;
            const program = value.data && value.data.program;

            if (program === 'spl-token' && parsed && parsed.type === 'mint' && parsed.info) {
              net.isTokenContract = true;
              const info = parsed.info || {};
              net.tokenMeta = {
                decimals: (typeof info.decimals === 'number') ? info.decimals : null,
                totalSupply: (info.supply !== undefined) ? String(info.supply) : null,
                mintAuthority: info.mintAuthority || null,
                freezeAuthority: info.freezeAuthority || null,
              };
            }
          } catch (_) {}
        } else {
          // value === null -> account does not exist on-chain
          net.noHistory = true;
          net.inactiveReason = 'Address has no on-chain history.';
          // This is not an "error" in UX terms
          if (net.error && /Balance RPC error/i.test(net.error)) {
            // keep real RPC errors; balance error alone isn't enough to mark it dead
          }
        }
      }
    } catch (e) {
      const msg = `AccountInfo RPC error: ${e.message}`;
      net.error = net.error ? `${net.error}; ${msg}` : msg;
      net.accountExecutable = false;
      net.isContract = false;
    }

    // 3) Signatures (transactions)
    try {
      const sigResp = await axios.post(
        rpcUrl,
        { jsonrpc: '2.0', id: 3, method: 'getSignaturesForAddress', params: [address, { limit: 10 }] },
        { timeout: 4000 }
      );

      if (sigResp.data && Array.isArray(sigResp.data.result)) {
        net.txsChecked = sigResp.data.result.length;
      }
    } catch (e) {
      const msg = `Signatures RPC error: ${e.message}`;
      net.error = net.error ? `${net.error}; ${msg}` : msg;
    }

    // Finalize unified status
    const bal = Number(net.balance || 0);
    const tx = Number(net.txsChecked || 0);

    if (net.noHistory) {
      net.status = 'inactive';
      if (!net.inactiveReason) net.inactiveReason = 'Address has no on-chain history.';
      // If we did get activity, override noHistory
      if (tx > 0 || bal > 0 || net.isContract || net.isTokenContract) {
        net.noHistory = false;
        net.inactiveReason = null;
        net.status = 'active';
      }
    } else if (tx > 0 || bal > 0 || net.isContract || net.isTokenContract) {
      net.status = 'active';
    } else {
      net.status = 'empty';
    }
  } catch (e) {
    net.error = e.message;
  }

    // Determine kind (best-effort)
    if (!net.kind) {
      if (net.isContract) net.kind = 'program';
      else if (net.isTokenContract) net.kind = 'mint';
      else if (net.noHistory) net.kind = 'unknown';
      else net.kind = 'wallet';
    }

  // SCAMSCAN_SOL_FORCE_KNOWN_MINTS_FINAL
  try {
    const __a = String(address || '').trim();
    if (__a === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
      net.tokenMeta = net.tokenMeta || {};
      if (!net.tokenMeta.symbol) net.tokenMeta.symbol = 'USDC';
      if (!net.tokenMeta.name) net.tokenMeta.name = 'USD Coin';
    } else if (__a === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') {
      net.tokenMeta = net.tokenMeta || {};
      if (!net.tokenMeta.symbol) net.tokenMeta.symbol = 'USDT';
      if (!net.tokenMeta.name) net.tokenMeta.name = 'Tether USD';
    }
  } catch (_) {}

  return {
    risk,
    warnings: net.scamSignals,
    onChain: {
      provider: 'solana-rpc',
      enabled: true,
      networks: [net]
    }
  };
}

module.exports = { analyzeSolanaAddressOnChain };