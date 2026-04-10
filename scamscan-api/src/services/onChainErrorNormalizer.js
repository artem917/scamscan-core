function sanitizeText(s) {
  if (s === null || typeof s === "undefined") return s;
  let t = String(s);

  // убираем "страшные" формулировки
  t = t.replace(/Network error:\s*/ig, "");

  // TRON no-history
  t = t.replace(
    /Account does not exist on TRON mainnet\.?/ig,
    "Address has no on-chain history."
  );

  // общий no-history
  t = t.replace(
    /Account does not exist\.?/ig,
    "Address has no on-chain history."
  );

  return t;
}

function classifyError(err) {
  const e = String(err || "").trim();
  const low = e.toLowerCase();

  const noHistory = /account does not exist|does not exist|unknown account|no such account|not found/.test(low);

  if (noHistory) {
    return {
      status: "inactive",
      noHistory: true,
      inactiveReason: "Address has no on-chain history."
    };
  }

  return {
    status: "inactive",
    noHistory: false,
    inactiveReason: "On-chain data temporarily unavailable. Try again later."
  };
}

function normalizeNetwork(net) {
  if (!net || typeof net !== "object") return net;

  // keep original text for matching
  const errText = sanitizeText(net.error || net.message || "");

  // 1) provider/noise errors: hide scary text from user
  //    (timeouts, rate limits, 5xx, TronGrid hiccups, RPC errors, etc.)
  if (errText) {
    // if it smells like "no history" we keep it as noHistory
    const lower = errText.toLowerCase();
    const isNoHistory = (
      lower.includes("account does not exist") ||
      lower.includes("does not exist") ||
      lower.includes("not found") ||
      lower.includes("no on-chain history") ||
      lower.includes("no history")
    );

    if (isNoHistory) {
      net.noHistory = true;
      net.status = "inactive";
      net.inactiveReason = net.inactiveReason || "Address has no on-chain history.";
    } else {
      net.status = net.status || "inactive";
      net.inactiveReason = net.inactiveReason || "On-chain data temporarily unavailable. Try again later.";
    }

    // kill scary raw error
    net.error = null;
  }

  // 2) if marked noHistory but reason missing
  if (net.noHistory && !net.inactiveReason) {
    net.inactiveReason = "Address has no on-chain history.";
  }

  // 3) if inactive and still has raw error
  if (net.status === "inactive" && net.error) {
    net.error = null;
    if (!net.inactiveReason) net.inactiveReason = "On-chain data temporarily unavailable. Try again later.";
  }

  return net;
}


function normalizeOnChain(onChain) {
  if (onChain && Array.isArray(onChain.networks)) {
    onChain.networks.forEach(normalizeNetwork);
  }
  return onChain;
}

function normalizePayload(payload) {
  try {
    if (payload && payload.details && payload.details.onChain) {
      normalizeOnChain(payload.details.onChain);
    }

    if (payload && Array.isArray(payload.warnings)) {
      payload.warnings = payload.warnings.map(sanitizeText);
    }
  } catch (_) {}

  return payload;
}

module.exports = {
  normalizePayload,
  normalizeOnChain,
  normalizeNetwork,
  sanitizeText
};
