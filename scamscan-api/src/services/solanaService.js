const axios = require('axios');

async function analyzeSolanaAddressOnChain(address) {
    const net = {
        network: 'Solana',
        api: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
        txsChecked: 0,
        scamSignals: [],
        error: null,
        status: 'inactive',
        balance: 0,
        nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 }
    };
    let risk = 'low';

    try {
        const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

        // 1. Get Balance
        try {
            const balResp = await axios.post(
                rpcUrl,
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getBalance',
                    params: [address]
                },
                { timeout: 4000 }
            );

            if (balResp.data && balResp.data.result && typeof balResp.data.result.value === 'number') {
                net.balance = balResp.data.result.value; // lamports
                net.status = 'active';
            }
        } catch (e) {
            net.error = `Balance RPC error: ${e.message}`;
        }

        // 2. Get basic account info (to detect contract vs wallet)
        try {
            const accResp = await axios.post(
                rpcUrl,
                {
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'getAccountInfo',
                    params: [address, { encoding: 'jsonParsed' }]
                },
                { timeout: 4000 }
            );

            if (accResp.data && accResp.data.result) {
                const value = accResp.data.result.value;

                if (value) {
                    // executable === true -> программа (смарт-контракт)
                    const executable = !!value.executable;
                    net.accountExecutable = executable;
                    net.isContract = executable;

                    // Можно сохранить owner для инфы (мета-данные)
                    if (value.owner) {
                        net.owner = value.owner;
                    }

                    // Если раньше статус был inactive, но аккаунт существует — считаем active
                    if (net.status === 'inactive') {
                        net.status = 'active';
                    }
                } else {
                    // value === null -> аккаунта нет в цепи
                    net.accountExecutable = false;
                    net.isContract = false;
                    if (!net.error) {
                        net.error = 'Account does not exist on Solana mainnet.';
                    }
                }
            }
        } catch (e) {
            // Не убиваем весь анализ, просто логируем
            const msg = `AccountInfo RPC error: ${e.message}`;
            net.accountExecutable = false;
            net.isContract = false;
            net.error = net.error ? `${net.error}; ${msg}` : msg;
        }

        // 3. Get Signatures (Transactions)
        try {
            const sigResp = await axios.post(
                rpcUrl,
                {
                    jsonrpc: '2.0',
                    id: 3,
                    method: 'getSignaturesForAddress',
                    params: [address, { limit: 10 }]
                },
                { timeout: 4000 }
            );

            if (sigResp.data && Array.isArray(sigResp.data.result)) {
                net.txsChecked = sigResp.data.result.length;
            }
        } catch (e) {
            const msg = `Signatures RPC error: ${e.message}`;
            net.error = net.error ? `${net.error}; ${msg}` : msg;
        }

    } catch (e) {
        net.error = e.message;
    }

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
