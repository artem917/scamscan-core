const axios = require("axios");

const TRON_API_BASE = "https://api.trongrid.io";
const TRON_EMPTY_ADDRESS = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

function tronHex(h) {
  if (h === null || typeof h === "undefined") return "";
  h = String(h);
  if (h.startsWith("0x") || h.startsWith("0X")) return h.slice(2);
  return h;
}

function tronUint256(h) {
  try {
    const s = tronHex(h).trim();
    if (s === "") return null;
    const part = s.slice(0, 64);
    if (part.length < 64) return null;
    return BigInt("0x" + part);
  } catch (e) {
    return null;
  }
}

function tronAbiString(h) {
  try {
    const s = tronHex(h);
    if (s === "" || s.length < 128) return null;

    const off = Number(BigInt("0x" + s.slice(0, 64)));
    const lp = off * 2;
    if (s.length < lp + 64) return null;

    const ln = Number(BigInt("0x" + s.slice(lp, lp + 64)));
    const dp = lp + 64;
    if (s.length < dp + ln * 2) return null;

    let out = Buffer.from(s.slice(dp, dp + ln * 2), "hex").toString("utf8");
    while (out.length > 0 && out.charCodeAt(out.length - 1) === 0) out = out.slice(0, -1);
    return out === "" ? null : out;
  } catch (e) {
    return null;
  }
}

async function tronTriggerConstant(contract, selector, headers) {
  try {
    const body = {
      owner_address: TRON_EMPTY_ADDRESS,
      contract_address: contract,
      function_selector: selector,
      visible: true
    };
    const r = await axios.post(
      `${TRON_API_BASE}/wallet/triggerconstantcontract`,
      body,
      { headers, timeout: 20000 }
    );
    const cr = r && r.data && r.data.constant_result && r.data.constant_result[0];
    if (cr === null || typeof cr === "undefined") return null;
    return cr;
  } catch (e) {
    return null;
  }
}

async function fetchTrc20MetaByCalls(contract, headers, formatUnitsBigIntFn) {
  try {
    const nameHex = await tronTriggerConstant(contract, "name()", headers);
    const symbolHex = await tronTriggerConstant(contract, "symbol()", headers);
    const decHex = await tronTriggerConstant(contract, "decimals()", headers);
    const tsHex = await tronTriggerConstant(contract, "totalSupply()", headers);

    const name = tronAbiString(nameHex);
    const symbol = tronAbiString(symbolHex);

    let decimals = null;
    const dBi = tronUint256(decHex);
    if (dBi !== null) {
      const dn = Number(dBi);
      if (isFinite(dn) && dn >= 0 && dn <= 255) decimals = dn;
    }

    const tsBi = tronUint256(tsHex);
    const totalSupply = tsBi !== null ? tsBi.toString() : null;

    const meta = {
      name: name || null,
      symbol: symbol || null,
      decimals: decimals,
      totalSupply: totalSupply
    };

    if (
      meta.totalSupply !== null &&
      meta.decimals !== null &&
      typeof formatUnitsBigIntFn === "function"
    ) {
      meta.totalSupplyFormatted = formatUnitsBigIntFn(meta.totalSupply, meta.decimals);
    }

    const empty =
      (meta.name === null || meta.name === "") &&
      (meta.symbol === null || meta.symbol === "") &&
      meta.decimals === null &&
      (meta.totalSupply === null || meta.totalSupply === "");

    if (empty) return null;
    return meta;
  } catch (e) {
    return null;
  }
}

module.exports = { fetchTrc20MetaByCalls };
