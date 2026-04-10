/**
 * TON service (wallet + contract) for ScamScan
 * - Normalizes TON addresses (optional canonical form via tonapi parse)
 * - Fetches balance / txCount via toncenter with tonapi fallback
 * - Detects wallet-contracts by code_hash (best-effort)
 * - Detects Jetton master contracts and attaches tokenMeta via tonapi /jettons/{address}
 *
 * NOTE: Keep it defensive: providers are flaky, and we prefer returning partial info vs 500.
 */
const axios = require("axios");

const TONCENTER = "https://toncenter.com/api/v2";
const TONAPI = "https://tonapi.io/v2";
const TONAPI_CACHE_TTL_MS = Number(process.env.TONAPI_CACHE_TTL_MS || 10 * 60 * 1000);
const TONAPI_RETRY_COUNT = Math.max(1, Number(process.env.TONAPI_RETRY_COUNT || 3));
const _tonApiCache = new Map();

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

function tonApiHeaders() {
    const h = { Accept: "application/json" };
    const key = process.env.TONAPI_KEY || process.env.TON_API_KEY;
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
}

// TON адреса могут содержать base64url + "_" "-" "=" и raw-формат 0:<hex>
function normalizeTonAddress(addr) {
    return String(addr || "").trim().replace(/[^A-Za-z0-9_\-:=]/g, "");
}

function isTonRawAddress(addr) {
      return /^-?\d+:([a-fA-F0-9]{64})$/.test(String(addr || "").trim());
  }



function isTonFriendlyAddress(addr) {
    // Very permissive (does not validate CRC), but good enough to decide routing.
    // Typical: EQ..., UQ..., kQ...
    return /^[A-Za-z0-9_\-]{48,}=?=?$/.test(String(addr || "").trim());
}

async function toncenterRequest(method, params) {
    try {
        const url = `${TONCENTER}/${method}`;
        const res = await axios.get(url, { params, timeout: 10000 });
        if (res && res.data && res.data.ok) return res.data.result;
    } catch (e) {}
    return null;
}

async function tonapiRequest(path) {
    try {
        const url = `${TONAPI}/${path}`;
        const res = await axios.get(url, { timeout: 10000, headers: tonApiHeaders() });
        return res.data;
    } catch (e) {
        return null;
    }
}

function _tonCacheKey(kind, addr) {
    return `${kind}:${String(addr || "").trim().toLowerCase()}`;
}

function _tonCacheGet(kind, addr) {
    const key = _tonCacheKey(kind, addr);
    const hit = _tonApiCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
        _tonApiCache.delete(key);
        return null;
    }
    return hit.value;
}

function _tonCacheSet(kind, addr, value, ttlMs = TONAPI_CACHE_TTL_MS) {
    if (!value) return value;
    _tonApiCache.set(_tonCacheKey(kind, addr), {
        value,
        expiresAt: Date.now() + Math.max(1000, Number(ttlMs) || TONAPI_CACHE_TTL_MS)
    });
    return value;
}

// Canonicalize friendly/raw address via tonapi parse (best-effort)
// Returns {bounceable, nonBounceable, raw} or null
async function tonApiParseAddressFull(addr) {
      const clean = normalizeTonAddress(addr);
      if (!clean) return null;

      const data = await tonapiRequest("address/" + encodeURIComponent(clean) + "/parse");
      if (!data || typeof data !== "object") return null;

      const bounce = data.bounceable || data.bounceable_address || data.bounceable_address_b64url || null;
      const nonBounce = data.non_bounceable || data.non_bounceable_address || data.non_bounceable_address_b64url || null;
      const rawForm = data.raw_form || data.raw || null;

      return {
          clean,
          bounceable: (typeof bounce === "string" && bounce.length > 10) ? bounce : null,
          nonBounceable: (typeof nonBounce === "string" && nonBounce.length > 10) ? nonBounce : null,
          raw: (typeof rawForm === "string" && rawForm.length > 10) ? String(rawForm).toLowerCase() : (isTonRawAddress(clean) ? clean.toLowerCase() : null)
      };
  }

  // Backward-compat: return bounceable only
  async function tonApiParseAddress(addr) {
      const p = await tonApiParseAddressFull(addr);
      return p && p.bounceable ? p.bounceable : null;
  }

  // friendly <-> raw bundle
  async function tonNormalizeAddressBundle(addr) {
      const clean = normalizeTonAddress(addr);
      if (!clean) {
          return { clean: "", used: "", bounceable: null, nonBounceable: null, raw: null, warnings: ["empty"] };
      }

      const p = await tonApiParseAddressFull(clean);

      const bounceable = (p && p.bounceable) ? p.bounceable : (isTonFriendlyAddress(clean) ? clean : null);
      const nonBounceable = (p && p.nonBounceable) ? p.nonBounceable : null;
      const raw = (p && p.raw) ? String(p.raw).toLowerCase() : (isTonRawAddress(clean) ? clean.toLowerCase() : null);

      const used = bounceable || raw || clean;

      const warnings = [];
      if (!p) warnings.push("tonapi_parse_unavailable");
      if (!raw && isTonRawAddress(clean)) warnings.push("raw_detected_but_raw_missing");
      if (!bounceable && isTonFriendlyAddress(clean)) warnings.push("friendly_detected_but_bounceable_missing");

      return { clean, used, bounceable, nonBounceable, raw, warnings };
  }

function normalizeJettonMeta(jet) {
    if (!jet || typeof jet !== "object") return null;

    const meta = jet.metadata || (jet.jetton && jet.jetton.metadata) || jet.content || null;

    const name = (meta && (meta.name || meta.title)) || jet.name || null;
    const symbol = (meta && meta.symbol) || jet.symbol || null;

    const decRaw = meta && meta.decimals;
    const decimals =
        decRaw !== undefined && decRaw !== null && decRaw !== "" && Number.isFinite(Number(decRaw))
            ? Number(decRaw)
            : null;

    const totalSupply =
        jet.total_supply !== undefined && jet.total_supply !== null
            ? String(jet.total_supply)
            : (jet.totalSupply !== undefined && jet.totalSupply !== null ? String(jet.totalSupply) : null);

    const out = {};
    if (name) out.name = name;
    if (symbol) out.symbol = symbol;
    if (decimals !== null) out.decimals = decimals;
    if (totalSupply !== null) out.totalSupply = totalSupply;

    // Extra fields (optional; front can ignore)
    if (jet.admin_address) out.adminAddress = jet.admin_address;
    if (jet.mintable !== undefined) out.mintable = !!jet.mintable;

    return Object.keys(out).length ? out : null;
}

function formatUnits(raw, decimals) {
    try {
        const bi = BigInt(String(raw));
        const d = Math.max(0, Number(decimals || 0));
        const base = 10n ** BigInt(d);
        const whole = bi / base;
        const frac = bi % base;
        if (!d) return whole.toString();
        let fracStr = frac.toString().padStart(d, "0").replace(/0+$/, "");
        return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
    } catch (e) {
        return String(raw);
    }
}


async function tonApiGetJettonInfo(addr) {
    if (!addr) return null;
    const cached = _tonCacheGet("jetton_info", addr);
    if (cached) return cached;
    let last = null;
    for (let i = 0; i < TONAPI_RETRY_COUNT; i++) {
        last = await tonapiRequest(`jettons/${encodeURIComponent(addr)}`);
        if (last) return _tonCacheSet("jetton_info", addr, last);
    }
    return last;
}

async function tonApiGetJettonWalletData(addr) {
    const cached = _tonCacheGet("jetton_wallet_data", addr);
    if (cached) return cached;
    let last = null;
    for (let i = 0; i < TONAPI_RETRY_COUNT; i++) {
        try {
            last = await tonapiRequest(`blockchain/accounts/${encodeURIComponent(addr)}/methods/get_wallet_data`);
        } catch (e) {
            last = null;
        }
        if (last && last.success && Number(last.exit_code || 0) === 0 && last.decoded) {
            return _tonCacheSet("jetton_wallet_data", addr, last);
        }
    }
    return last;
}


async function analyzeTonAddress(address) {
      const norm = await tonNormalizeAddressBundle(address);
      const clean = norm.clean;
      const canon = norm.bounceable || null;
      const addr = norm.used;


    const result = {
        input: address,
        chain: "ton-like",
        provider: null,
        addressNormalized: canon || clean,
          addressRaw: norm.raw || null,
          addressNonBounceable: norm.nonBounceable || null,
        status: "unknown",
        kind: null,

        balance: 0,
          balanceKnown: false,   // true if provider returned balance
          // in TON (number); never null (frontend-friendly)
        txCount: 0,

        isContract: false,
        isWalletContract: false,
        walletType: null,

        isTokenContract: false,
        tokenMeta: null,

        noHistory: false,
        inactiveReason: null,

        warnings: [],
        scamSignals: [],
        errors: [],

        raw: {
            addressUsed: addr,
            canon: canon || null,
              raw: norm.raw || null,
              norm: norm,
            state: null,
            txs: null,
        }
    };

    if (!addr || (!isTonRawAddress(addr) && !isTonFriendlyAddress(addr))) {
        result.errors.push("Invalid TON address format");
        result.status = "invalid";
        return result;
    }

    // 1) account state
    let state = await toncenterRequest("getAddressInformation", { address: addr });
    if (state) {
        result.provider = "toncenter";
        result.raw.state = state;
    } else {
        const api = await tonapiRequest(`blockchain/accounts/${encodeURIComponent(addr)}`);
        const acct = api && (api.account || api);
        if (acct) {
            state = acct;
            result.provider = "tonapi";
            result.raw.state = acct;
        }
    }

    if (state) {
        // balance
        const balRaw = state.balance ?? state.balance_nano ?? state.balanceNano ?? null;
        if (balRaw !== null && balRaw !== undefined && balRaw !== "") {
            // toncenter: string nano; tonapi: string nano
            const n = Number(balRaw);
            if (Number.isFinite(n)) { result.balance = n / 1e9; result.balanceKnown = true; }
        }

        // code / code_hash
        const code = state.code ?? null;
        const codeHash = state.code_hash ?? state.codeHash ?? null;

        result.isContract = !!(code && String(code).length > 0);

        if (codeHash) {
            result.codeHash = String(codeHash);
            if (TON_WALLET_CODEHASHES.has(result.codeHash)) {
                result.isWalletContract = true;
                result.walletType = "wallet";
            }
        }

        // status hints
        const st = (state.state || state.status || state.account_state || "").toString().toLowerCase();
        if (st.includes("uninit") || st.includes("inactive")) {
            result.status = "empty";
            result.noHistory = true;
            result.inactiveReason = "uninitialized";
        } else if (st.includes("frozen")) {
            result.status = "frozen";
            result.inactiveReason = "frozen";
        } else if (st) {
            // active / ok etc
            result.status = "active";
        }
    }

    // If toncenter didn’t provide code_hash, try to enrich via tonapi once more (cheap, helps contract/wallet detection)
    if (state && !state.code_hash && !state.codeHash) {
        const api = await tonapiRequest(`blockchain/accounts/${encodeURIComponent(addr)}`);
        const acct = api && (api.account || api);
        const ch = acct && (acct.code_hash || acct.codeHash);
        if (ch) {
            result.codeHash = String(ch);
            result.isContract = result.isContract || !!(acct.code && String(acct.code).length > 0);
            if (TON_WALLET_CODEHASHES.has(result.codeHash)) {
                result.isWalletContract = true;
                result.walletType = "wallet";
            }
            if (!result.provider) result.provider = "tonapi";
        }
    }

    // 2) Jetton meta (jetton master OR jetton wallet via get_wallet_data)
    if (!result.isWalletContract) {
        const jet = await tonApiGetJettonInfo(addr);
        const jm = normalizeJettonMeta(jet);

        if (jm) {
            // Jetton master
            result.kind = "jetton";
            result.isTokenContract = true;
            result.tokenMeta = jm;
            result.isContract = true;

            if (jm.mintable) {
                result.scamSignals.push("INFO: Jetton is mintable (supply can be increased).");
            }
            if (jm.adminAddress) {
                result.scamSignals.push("INFO: Jetton admin address is set.");
            }
        } else {
            // Jetton wallet (holder contract): try get_wallet_data via TonAPI
            const wd = await tonApiGetJettonWalletData(addr);
            const dec = wd && wd.success && Number(wd.exit_code || 0) === 0 ? (wd.decoded || null) : null;

            if (dec && dec.jetton && dec.balance != null) {
                result.kind = "jetton_wallet";
                result.isTokenContract = true;
                result.isContract = true;

                result.jettonMaster = dec.jetton;
                result.owner = dec.owner || null;
                result.tokenBalanceRaw = String(dec.balance);

                // подтягиваем meta master-а
                const jet2 = await tonApiGetJettonInfo(dec.jetton);
                const jm2 = normalizeJettonMeta(jet2);
                if (jm2) {
                    result.tokenMeta = jm2;
                    result.tokenBalance = formatUnits(result.tokenBalanceRaw, Number(jm2.decimals || 0));

                    if (jm2.mintable) {
                        const s = "INFO: Jetton is mintable (supply can be increased).";
                        if (!result.scamSignals.some(x => String(x).toLowerCase() === s.toLowerCase())) result.scamSignals.push(s);
                    }
                    if (jm2.adminAddress) {
                        const s2 = "INFO: Jetton admin address is set.";
                        if (!result.scamSignals.some(x => String(x).toLowerCase() === s2.toLowerCase())) result.scamSignals.push(s2);
                    }
                }
            }
        }
    }

    // 3) tx count
    let txs = await toncenterRequest("getTransactions", { address: addr, limit: 20 });
    if (txs) {
        result.raw.txs = txs;
    } else {
        const api = await tonapiRequest(`blockchain/accounts/${encodeURIComponent(addr)}/transactions?limit=20`);
        txs = api && (api.transactions || api);
        result.raw.txs = txs || null;
        if (!result.provider) result.provider = "tonapi";
    }

    if (Array.isArray(txs)) {
        result.txCount = txs.length;
    } else {
        // Some APIs return {transactions:[...]}
        if (txs && Array.isArray(txs.transactions)) result.txCount = txs.transactions.length;
    }

    // Final status
    const bal = Number(result.balance || 0);
    const hasBal = Number.isFinite(bal) && bal > 0;
    if (result.status === "unknown") {
        if (result.txCount > 0 || hasBal || result.isContract) result.status = "active";
        else {
            result.status = "empty";
            result.noHistory = true;
        }
    }

    if (!result.kind) {
        result.kind = result.isWalletContract ? "wallet_contract" : (result.isTokenContract ? "jetton" : (result.isContract ? "contract" : "wallet"));
    }

    return result;
}

function wrapTonForWalletService(tonResult) {
    const kind =
        (tonResult && tonResult.kind) ||
        (tonResult && tonResult.isWalletContract ? "wallet_contract" : (tonResult && tonResult.isTokenContract ? "jetton" : (tonResult && tonResult.isContract ? "contract" : "wallet")));

    return {
        provider: tonResult.provider || "ton",
        networks: [
            {
                network: "ton",
                address: tonResult.addressNormalized || tonResult.input,
                addressNormalized: tonResult.addressNormalized || tonResult.input,
                explorerUrl: `https://tonscan.org/address/${encodeURIComponent(tonResult.addressNormalized || tonResult.input)}`,

                kind,
                status: tonResult.status || "unknown",

                balance: tonResult.balance,
                txCount: Number(tonResult.txCount || 0),

                isContract: !!tonResult.isContract,
                isWalletContract: !!tonResult.isWalletContract,
                walletType: tonResult.walletType || null,

                isTokenContract: !!tonResult.isTokenContract,
                tokenMeta: tonResult.tokenMeta || null,

                jettonMaster: tonResult.jettonMaster || null,
                jettonMasterExplorerUrl: tonResult.jettonMaster ? `https://tonscan.org/address/${encodeURIComponent(tonResult.jettonMaster)}` : null,
                owner: tonResult.owner || null,
                tokenBalance: tonResult.tokenBalance || null,
                tokenBalanceRaw: tonResult.tokenBalanceRaw || null,


                scamSignals: Array.isArray(tonResult.scamSignals) ? tonResult.scamSignals : [],
                errors: Array.isArray(tonResult.errors) ? tonResult.errors : [],
                warnings: Array.isArray(tonResult.warnings) ? tonResult.warnings : [],
            },
        ],
    };
}

async function analyzeTonAddressOnChain(address) {
    const r = await analyzeTonAddress(address);
    return { chain: "ton-like", onChain: wrapTonForWalletService(r) };
}

module.exports = {
    analyzeTonAddress,
    analyzeTonAddressOnChain,
};
