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

function collectUrlReasons(details) {
  const reasons = [];
  if (!details) return reasons;
  const whois = details.whois || {};
  const content = details.content || {};

  if (typeof whois.ageDays === 'number') {
    if (whois.ageDays < 30) reasons.push('very young domain (< 30 days)');
    else if (whois.ageDays < 180) reasons.push('young domain (< 6 months)');
  }
  if (typeof whois.riskScore === 'number' && whois.riskScore > 0) {
    reasons.push('WHOIS risk score: ' + whois.riskScore);
  }

  if (Array.isArray(content.matches) && content.matches.length) {
    const sample = content.matches.slice(0, 5).join(', ');
    reasons.push('suspicious phrases on page: ' + sample);
  }

  if (Array.isArray(content.wallets) && content.wallets.length) {
    reasons.push('crypto wallets detected on the page');
  }

  if (details.isWhitelisted) {
    reasons.push('domain is in trusted whitelist (risk score relaxed)');
  }

  return reasons;
}

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

function formatCheckResult(opts) {
  const type = opts.type;
  const input = opts.input;
  const data = opts.data || {};
  const isPro = !!opts.isPro;
  const remaining = typeof opts.remaining === 'number' ? opts.remaining : null;
  const maxFree = typeof opts.maxFree === 'number' ? opts.maxFree : null;

  const riskLevel = mapRiskLevel(data);
  const emoji = riskEmoji(riskLevel);
  const verdict = data.verdict || data.status || 'unknown';
  const riskScore = typeof data.riskScore === 'number' ? data.riskScore : null;

  let header = 'Risk: ' + emoji + ' *' + String(riskLevel).toUpperCase() + '*';
  if (verdict) header += ' (verdict: ' + verdict + ')';
  if (riskScore !== null) header += '\nScore: ' + riskScore + '/100';

  let typeLabel = 'unknown';
  if (type === 'url') typeLabel = 'URL';
  else if (type === 'wallet') typeLabel = 'wallet';
  else if (type === 'contract') typeLabel = 'contract';

  const lines = [];
  lines.push(header);
  lines.push('');
  lines.push('Type: ' + typeLabel);
  lines.push('Input: `' + input + '`');
  lines.push('');

  let reasons = [];
  const details = data.details || {};
  if (type === 'url') reasons = collectUrlReasons(details);
  else if (type === 'wallet') reasons = collectWalletReasons(details);
  else if (type === 'contract') reasons = collectContractReasons(data);

  if (reasons.length) {
    lines.push('Summary:');
    reasons.slice(0, 6).forEach(function (r) {
      lines.push('• ' + r);
    });
  } else {
    lines.push('Summary: engine did not highlight any specific additional risk factors.');
  }

  lines.push('');
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
