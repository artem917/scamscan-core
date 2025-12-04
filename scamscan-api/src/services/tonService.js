const axios = require("axios");

// TON wallet code hashes
// Эти хэши — официальные коды TON-кошельков (стандартные контракты)
// Если код адреса совпадает с одним из них → это обычный wallet, НЕ smart-contract
const TON_WALLET_CODEHASHES = new Set([
    // v3
    "857bb3eeb1b9ebce3b3b207db2d0bbd10b191ed257a7b82d49f683e4bd2f8cd0", // v3R1
    "b08b8510cc2f6e0f2f6213b5636e33d7e6443da8932e8def5a0e327c52fa0da1", // v3R2

    // v4
    "f3e8e3eec1abcb447ded60a1e00c7cd5f9126eb47f55bb2b5f7f7c32a2dfc047", // v4R1
    "7f602a58aab6fa41063f63683bcab9a9a56dd97ab3c4a45e485ace180105d581", // v4R2

    // highload v1/v2
    "492459e6f43dc3dfbd2a0d6d683c90e3f1bfa6fe9f6cf2c6938e615cb78f6f91",
    "3b85b1ecdcf7192b4f8a82e5b80e6ca0e9b8148f1d626bb8b078d5d927e0c8ed",

    // multisig
    "ae32e5b3e2a7b18101e7c0fe8f5a1bdc9b3bf762b0bf61c96f6c2c22fcf04e3a"
]);

// RPC endpoints
const TONCENTER = "https://toncenter.com/api/v2";
const TONAPI = "https://tonapi.io/v2";

// Ограничение на количество транзакций
const TX_LIMIT = 15;

// Helper: нормализация адресов TON
function normalizeTonAddress(addr) {
    return addr.replace(/[^A-Za-z0-9]/g, "");
}

// Запрос к toncenter
async function toncenterRequest(method, params) {
    try {
        const url = `${TONCENTER}/${method}`;
        const res = await axios.get(url, { params, timeout: 8000 });
        if (res.data && res.data.ok) return res.data.result;
    } catch (e) {}
    return null;
}

// Запрос к tonapi
async function tonapiRequest(path) {
    try {
        const url = `${TONAPI}/${path}`;
        const res = await axios.get(url, { timeout: 8000 });
        return res.data;
    } catch (e) {}
    return null;
}



//
//  MAIN ANALYSIS
//
async function analyzeTonAddress(address) {
    const clean = normalizeTonAddress(address);

    const result = {
        network: "ton",
        address: clean,
        isContract: false,
        isWalletContract: false,
        walletType: null,
        codeHash: null,
        balance: null,
        txCount: 0,
        status: "unknown",
        provider: null,
        errors: [],
    };

    //
    // 1 — Получаем account state
    //
    let state = await toncenterRequest("getAddressInformation", { address: clean });

    if (!state) {
        // fallback tonapi
        const api = await tonapiRequest(`blockchain/accounts/${clean}`);
        if (api && api.account) {
            state = {
                balance: api.account.balance,
                state: api.account.status,
                code: api.account.code,
                code_hash: api.account.code_hash,
            };
            result.provider = "tonapi";
        } else {
            result.errors.push("All RPC providers failed");
            return result;
        }
    } else {
        result.provider = "toncenter";
    }

    //
    // 2 — Парсим стейт
    //
    try {
        if (state.balance !== undefined) {
            result.balance = Number(state.balance) / 1e9; // nanotons → TON
        }

        if (state.code_hash) {
            result.codeHash = state.code_hash.toLowerCase();
        }

        if (state.code) {
            // toncenter → base64, tonapi → hex
            if (state.code.length < 10) {
                result.codeHash = null;
            }
        }

        if (state.state) result.status = state.state;
    } catch (e) {
        result.errors.push("State parsing error");
    }

    //
    // 3 — Определяем WALLET vs SMART-CONTRACT
    //
    if (result.codeHash) {
        if (TON_WALLET_CODEHASHES.has(result.codeHash)) {
            result.isWalletContract = true;
            result.isContract = false;
        } else {
            result.isContract = true;
        }
    } else {
        // Нет code → обычный пользовательский кошелёк (non-contract)
        result.isContract = false;
    }

    //
    // 4 — Получаем транзакции
    //
    let tx = await toncenterRequest("getTransactions", {
        address: clean,
        limit: TX_LIMIT
    });

    if (!tx) {
        const apiTx = await tonapiRequest(`blockchain/accounts/${clean}/transactions`);
        if (apiTx && apiTx.transactions) {
            result.txCount = apiTx.transactions.length;
        }
    } else {
        result.txCount = tx.length;
    }

    //
    // 5 — Smart-contract analysis placeholder
    //
    if (result.isContract && !result.isWalletContract) {
        result.contractAnalysis = {
            risk: "unknown",
            warnings: [
                "[ton] Smart-contract detected — full audit not implemented yet",
            ],
        };
    }

    return result;
}

function wrapTonForWalletService(tonResult) { return { onChain: { provider: tonResult.provider || "ton", networks: [ { network: "ton", balance: tonResult.balance, txCount: tonResult.txCount, status: tonResult.status, isContract: tonResult.isContract, isWalletContract: tonResult.isWalletContract, nativeCurrency: { name: "TON", symbol: "TON", decimals: 9 }, honeypotCheck: tonResult.contractAnalysis || null } ] } }; }

module.exports = { analyzeTonAddressOnChain: async function (address) { const res = await analyzeTonAddress(address); return wrapTonForWalletService(res); }, analyzeTonAddress };