function isProbablyUrl(text) {
  if (!text) return false;
  const t = String(text).trim().toLowerCase();
  if (t.startsWith('http://') || t.startsWith('https://')) return true;
  if (t.includes(' ') || t.includes('\n')) return false;
  if (t.includes('.') && !t.startsWith('0x')) return true;
  return false;
}

function isEvmAddress(text) {
  if (!text) return false;
  const t = String(text).trim();
  return /^0x[a-fA-F0-9]{40}$/.test(t);
}

function detectInputType(text, forcedMode) {
  if (forcedMode && ['url', 'wallet', 'contract'].includes(forcedMode)) {
    return forcedMode;
  }
  if (isProbablyUrl(text)) return 'url';
  if (isEvmAddress(text)) return 'contract';
  return 'wallet';
}

function mapRiskLevel(data) {
  if (data && typeof data.risk === 'string') {
    return data.risk.toLowerCase();
  }
  if (data && typeof data.riskScore === 'number') {
    const s = data.riskScore;
    if (s < 30) return 'low';
    if (s < 60) return 'medium';
    if (s < 85) return 'high';
    return 'critical';
  }
  return 'unknown';
}

function riskEmoji(level) {
  switch ((level || '').toLowerCase()) {
    case 'low': return '🟢';
    case 'medium': return '🟡';
    case 'high': return '🟠';
    case 'critical': return '🔴';
    default: return '⚪️';
  }
}

// --- URL helpers -------------------------------------------------------

function collectUrlReasons(details) {
  const reasons = [];
  if (!details) return reasons;
  const whois = details.whois || {};
  const content = details.content || {};

  const rawWhois = whois.rawData || {};

  if (typeof rawWhois.ageDays === 'number') {
    if (rawWhois.ageDays < 7) {
      reasons.push('very new domain (' + rawWhois.ageDays + ' days old)');
    } else if (rawWhois.ageDays < 30) {
      reasons.push('young domain (' + rawWhois.ageDays + ' days old)');
    } else if (rawWhois.ageDays < 365) {
      reasons.push('domain age: ' + rawWhois.ageDays + ' days');
    }
  } else if (typeof whois.ageDays === 'number') {
    if (whois.ageDays < 30) reasons.push('very young domain (< 30 days)');
    else if (whois.ageDays < 180) reasons.push('young domain (< 6 months)');
  }

  if (typeof whois.riskScore === 'number' && whois.riskScore > 0) {
    reasons.push('WHOIS risk score: ' + whois.riskScore);
  }

  if (Array.isArray(content.matches) && content.matches.length) {
    const unique = Array.from(new Set(content.matches.map(String)));
    const sample = unique.slice(0, 5).join(', ');
    reasons.push('scam-like phrases on page: ' + sample);
  }

  if (Array.isArray(content.wallets) && content.wallets.length) {
    reasons.push('crypto wallets exposed directly on the page');
  }

  if (details.isWhitelisted) {
    reasons.push('domain is in trusted whitelist (risk score relaxed)');
  }

  return reasons;
}

function buildUrlSections(data) {
  const lines = [];
  const details = data.details || {};
  const whois = details.whois || {};
  const content = details.content || {};

  const reasons = collectUrlReasons(details);

  const riskScore = typeof data.riskScore === 'number' ? data.riskScore : null;
  const riskRaw = (data.risk || data.verdict || '').toString().toLowerCase();
  const hasContent = content && !content.error && content.source && content.source !== "failed";

  const isHigh = riskRaw === 'high' || riskRaw === 'critical' || (riskScore !== null && riskScore >= 70);
  const isMedium = !isHigh && (riskRaw === 'medium' || (riskScore !== null && riskScore >= 30));
  const isLow = !isHigh && !isMedium;

  // 1) High / medium risk → объясняем, что сработало
  if ((isHigh || isMedium) && Array.isArray(reasons) && reasons.length) {
    lines.push('Why this URL triggered risk signals:');
    reasons.slice(0, 4).forEach(function (r) {
      lines.push('• ' + r);
    });
    lines.push('');
  }

  // 2) Низкий риск + был контент → аккуратные "плюсы"
  if (isLow && hasContent) {
    const positives = [];

    const hasPhrases = Array.isArray(content.matches) && content.matches.length > 0;
    const hasWallets = Array.isArray(content.wallets) && content.wallets.length > 0;

    if (!hasPhrases) {
      positives.push('We did not detect common scam-like phrases in the visible page content.');
    }
    if (!hasWallets) {
      positives.push('We did not find crypto wallet addresses publicly exposed on the landing page.');
    }

    const rawWhois = whois.rawData || {};
    const ageDays = typeof rawWhois.ageDays === 'number' ? rawWhois.ageDays : whois.ageDays;
    const registrarRiskScore = typeof whois.riskScore === 'number' ? whois.riskScore : null;

    if (typeof ageDays === 'number') {
      if (ageDays >= 365) {
        positives.push('WHOIS shows an established domain (' + ageDays + ' days old).');
      } else {
        positives.push('WHOIS shows a registered domain (' + ageDays + ' days old).');
      }
    }

    if (registrarRiskScore === 0) {
      positives.push('WHOIS data providers did not flag this domain with any specific risk score.');
    }

    if (positives.length) {
      lines.push('Why this URL currently looks low-risk:');
      positives.slice(0, 4).forEach(function (p) {
        lines.push('• ' + p);
      });
      lines.push('');
    }
  }

  // 3) Структурные предупреждения по домену / URL
  let structural = [];
  if (Array.isArray(data.warnings)) structural = structural.concat(data.warnings);
  if (whois && Array.isArray(whois.warnings)) structural = structural.concat(whois.warnings);
  if (content && Array.isArray(content.walletWarnings)) structural = structural.concat(content.walletWarnings);

  structural = structural
    .map(function (w) { return (w || '').toString().trim(); })
    .filter(function (w) { return !!w; });

  const seenStructural = {};
  structural = structural.filter(function (w) {
    if (seenStructural[w]) return false;
    seenStructural[w] = true;
    return true;
  });

  if (structural.length) {
    lines.push('Structural warnings (domain / URL):');
    structural.slice(0, 4).forEach(function (w) {
      lines.push('• ' + w);
    });
    lines.push('');
  }

  // 4) Кошельки, замеченные на странице
  if (content && Array.isArray(content.wallets) && content.wallets.length) {
    lines.push('Wallets detected on this page:');
    const wallets = content.wallets;
    const maxShow = 3;
    wallets.slice(0, maxShow).forEach(function (w) {
      if (!w) return;
      const addr = w.address || w.value || w;
      const chain = w.detectedChain || w.chain || 'unknown';
      lines.push('• ' + addr + ' (' + chain + ')');
    });
    if (wallets.length > maxShow) {
      lines.push('• ... +' + (wallets.length - maxShow) + ' more address(es)');
    }
    lines.push('');
  }

  // 5) Короткий WHOIS-снэпшот
  const rawWhois = whois.rawData || {};
  const registrar = rawWhois.registrar || rawWhois.registrarName || whois.registrar || null;
  const createdAt = rawWhois.createdAt || rawWhois.creationDate || null;
  const ageDays = typeof rawWhois.ageDays === 'number' ? rawWhois.ageDays : whois.ageDays;

  if (registrar || createdAt || typeof ageDays === 'number') {
    lines.push('WHOIS snapshot:');
    if (registrar) {
      lines.push('• Registrar: ' + registrar);
    }
    if (createdAt) {
      lines.push('• Created: ' + createdAt);
    }
    if (typeof ageDays === 'number') {
      lines.push('• Domain age: ' + ageDays + ' days');
    }
    lines.push('');
  }

  return lines;
}


// --- Wallet helpers ----------------------------------------------------

function collectWalletReasons(details) {
  const reasons = [];
  if (!details) return reasons;
  const onChain = details.onChain || {};

  if (details.chain) {
    reasons.push('network: ' + details.chain);
  }

  if (typeof onChain.txCount === 'number') {
    if (onChain.txCount === 0) {
      reasons.push('no on-chain transactions for this address');
    } else if (onChain.txCount < 5) {
      reasons.push('very few on-chain transactions for this address');
    } else {
      reasons.push('total transactions: ' + onChain.txCount);
    }
  }

  if (Array.isArray(onChain.scamSignals) && onChain.scamSignals.length) {
    reasons.push('risk signals: ' + onChain.scamSignals.join(', '));
  }

  if (typeof onChain.balanceFormatted === 'string') {
    reasons.push('current balance: ' + onChain.balanceFormatted);
  }

  return reasons;
}

function buildWalletOnChainSnapshot(details) {
  const lines = [];
  if (!details || !details.onChain) return lines;
  const onChain = details.onChain;

  const networks = Array.isArray(onChain.networks) ? onChain.networks : [];
  if (!networks.length && !onChain.chain && !onChain.balanceFormatted) {
    return lines;
  }

  lines.push('On-chain snapshot:');
  const maxShow = 2;

  if (networks.length) {
    networks.slice(0, maxShow).forEach(function (net) {
      if (!net) return;
      const parts = [];
      const name = net.network || details.chain || 'unknown';
      if (net.displayBalance || net.balanceFormatted) {
        parts.push('balance ' + (net.displayBalance || net.balanceFormatted));
      } else if (typeof net.balance === 'number') {
        parts.push('raw balance ' + net.balance);
      }
      if (typeof net.txsChecked === 'number') {
        parts.push('txs checked: ' + net.txsChecked);
      }
      if (typeof net.txCount === 'number') {
        parts.push('tx count: ' + net.txCount);
      }
      if (Array.isArray(net.scamSignals) && net.scamSignals.length) {
        parts.push('signals: ' + net.scamSignals.join(', '));
      }
      if (net.status) {
        parts.push('status: ' + net.status);
      }
      if (parts.length) {
        lines.push('• ' + name + ': ' + parts.join(' · '));
      } else {
        lines.push('• ' + name);
      }
    });
    if (networks.length > maxShow) {
      lines.push('• ... +' + (networks.length - maxShow) + ' more network entries');
    }
  } else {
    const parts = [];
    if (details.chain) parts.push('network: ' + details.chain);
    if (typeof onChain.balanceFormatted === 'string') {
      parts.push('balance ' + onChain.balanceFormatted);
    }
    if (typeof onChain.txCount === 'number') {
      parts.push('tx count: ' + onChain.txCount);
    }
    if (parts.length) {
      lines.push('• ' + parts.join(' · '));
    }
  }

  lines.push('');
  return lines;
}

function walletLooksLikeSmartContract(details) {
  if (!details || !details.onChain) return false;
  const onChain = details.onChain;

  if (onChain.isContract === true || onChain.isTokenContract === true) {
    return true;
  }
  const rootType = String(onChain.contractAccountType || '').toLowerCase();
  if (rootType === 'contract' || rootType === 'token' || rootType === 'erc20' || rootType === 'erc721') {
    return true;
  }

  const networks = Array.isArray(onChain.networks) ? onChain.networks : [];
  for (let i = 0; i < networks.length; i++) {
    const net = networks[i];
    if (!net) continue;
    if (net.isContract === true || net.isTokenContract === true) {
      return true;
    }
    const t = String(net.contractAccountType || '').toLowerCase();
    if (t === 'contract' || t === 'token' || t === 'erc20' || t === 'erc721') {
      return true;
    }
  }

  return false;
}

// --- Contract helpers --------------------------------------------------

function collectContractReasons(data) {
  const reasons = [];
  if (!data) return reasons;

  const meta = data.contractMeta || {};
  const tokenMeta = data.tokenMeta || {};

  if (meta.name) {
    reasons.push('contract: ' + meta.name);
  }
  if (tokenMeta.name || tokenMeta.symbol) {
    reasons.push(
      'token: ' +
      (tokenMeta.name || '') +
      (tokenMeta.symbol ? ' (' + tokenMeta.symbol + ')' : '')
    );
  }

  if (meta.verifiedOnEtherscan === false) {
    reasons.push('contract source is NOT verified on the block explorer');
  } else if (meta.verifiedOnEtherscan === true) {
    reasons.push('contract source is verified on the block explorer');
  }

  if (meta.isProxy) {
    reasons.push('contract is a proxy');
  }

  if (Array.isArray(data.contentFlags) && data.contentFlags.length) {
    reasons.push('content flags: ' + data.contentFlags.join(', '));
  }

  if (data.contentError) {
    reasons.push('simulation / analysis error: ' + String(data.contentError));
  }

  return reasons;
}

function buildContractSections(data) {
  const lines = [];
  const reasons = collectContractReasons(data);

  if (reasons.length) {
    lines.push('Plain-English summary (contract):');
    reasons.slice(0, 6).forEach(function (r) {
      lines.push('• ' + r);
    });
    lines.push('');
  }

  const warnings = Array.isArray(data.warnings) ? data.warnings.slice(0, 6) : [];
  if (warnings.length) {
    lines.push('Warnings:');
    warnings.forEach(function (w) {
      lines.push('• ' + w);
    });
    lines.push('');
  }


  // Token meta: try root-level first, then nested in details.onChain.networks[*].tokenMeta
  var tokenMeta = data.tokenMeta || null;
  if (!tokenMeta) {
    try {
      var details = data.details || {};
      var onChain = details.onChain || {};
      var networks = Array.isArray(onChain.networks) ? onChain.networks : [];
      for (var i = 0; i < networks.length; i++) {
        var net = networks[i];
        if (net && net.tokenMeta) {
          tokenMeta = net.tokenMeta;
          break;
        }
      }
    } catch (e) {
      tokenMeta = null;
    }
  }

  if (tokenMeta && (tokenMeta.name || tokenMeta.symbol || typeof tokenMeta.decimals === 'number' ||
      tokenMeta.totalSupply || tokenMeta.totalSupplyFormatted)) {

    var parts = [];
    if (tokenMeta.symbol) parts.push('Symbol: ' + tokenMeta.symbol);
    if (tokenMeta.name) parts.push('Name: ' + tokenMeta.name);
    if (typeof tokenMeta.decimals === 'number') parts.push('Decimals: ' + tokenMeta.decimals);

    var totalSupplyValue = tokenMeta.totalSupplyFormatted || tokenMeta.totalSupply;
    if (totalSupplyValue !== undefined && totalSupplyValue !== null && totalSupplyValue !== '') {
      parts.push('Total supply: ' + totalSupplyValue);
    }

    if (parts.length) {
      lines.push('Token meta: ' + parts.join(' • '));
      lines.push('');
    }
  }

  return lines;
}

// --- Main formatter ----------------------------------------------------

function formatCheckResult(opts) {
  opts = opts || {};
  let type = opts.type;
  let input = opts.input;
  const data = opts.data || {};
  const isPro = !!opts.isPro;

  if (!type && typeof data.type === "string") {
    type = data.type;
  }
  if (!input) {
    if (typeof data.input === "string" && data.input.trim()) {
      input = data.input.trim();
    } else if (typeof data.value === "string" && data.value.trim()) {
      input = data.value.trim();
    }
  }

  const remaining = typeof opts.remaining === 'number' ? opts.remaining : null;
  const maxFree = typeof opts.maxFree === 'number' ? opts.maxFree : null;

  const riskLevel = mapRiskLevel(data);
  const emoji = riskEmoji(riskLevel);
  const verdict = data.verdict || data.status || 'unknown';
  const riskScore = typeof data.riskScore === 'number' ? data.riskScore : null;

  const details = data.details || {};
  const walletIsSmartContract = (type === 'wallet') && walletLooksLikeSmartContract(details);

  let header = 'Risk: ' + emoji + ' *' + String(riskLevel).toUpperCase() + '*';
  if (verdict) header += ' (verdict: ' + verdict + ')';
  if (riskScore !== null) header += '\nScore: ' + riskScore + '/100';

  let typeLabel = 'unknown';
  if (type === 'url') typeLabel = 'URL';
  else if (type === 'wallet') {
    typeLabel = walletIsSmartContract ? 'smart contract (detected in wallet mode)' : 'wallet';
  } else if (type === 'contract') typeLabel = 'contract';

  const lines = [];
  lines.push(header);
  lines.push('');
  lines.push('Type: ' + typeLabel);
  lines.push('Input: `' + input + '`');
  lines.push('');

  if (type === 'url') {
    Array.prototype.push.apply(lines, buildUrlSections(data));
  } else if (type === 'wallet') {
    const reasons = collectWalletReasons(details);
    if (walletIsSmartContract) {
      reasons.unshift('smart contract detected; consider running a contract-level scan for full analysis');
    }
    if (reasons.length) {
      lines.push('Summary:');
      reasons.slice(0, 6).forEach(function (r) {
        lines.push('• ' + r);
      });
      lines.push('');
    }
    const onChainLines = buildWalletOnChainSnapshot(details);
    Array.prototype.push.apply(lines, onChainLines);
  } else if (type === 'contract') {
    Array.prototype.push.apply(lines, buildContractSections(data));
  } else {
    const reasons = [];
    if (Array.isArray(data.warnings) && data.warnings.length) {
      data.warnings.slice(0, 6).forEach(function (w) {
        reasons.push(String(w));
      });
    }
    if (reasons.length) {
      lines.push('Summary:');
      reasons.forEach(function (r) {
        lines.push('• ' + r);
      });
      lines.push('');
    }
  }

  lines.push('For a full technical breakdown, use the web interface: https://scamscan.online');
  lines.push('');
  if (isPro) {
    lines.push('_Status: PRO user, no daily limits._');
  } else if (remaining !== null && maxFree !== null) {
    const used = maxFree - remaining;
    lines.push('_Daily limit: ' + used + '/' + maxFree + ' checks used today._');
  }

  return lines.join('\n');
}

module.exports = {
  detectInputType: detectInputType,
  formatCheckResult: formatCheckResult
};
