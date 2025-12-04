function detectType(input) {
    if (!input) return 'unknown';
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(input)) return 'ip';
    if (/^0x[a-fA-F0-9]{40}$/.test(input)) return 'wallet';
    if (/^T[A-Za-z0-9]{33}$/.test(input)) return 'wallet';
    if (/^[a-zA-Z0-9_-]{48}$/.test(input) || /^EQ[a-zA-Z0-9_-]{46}$/.test(input)) return 'wallet';
    
    // BTC MUST BE BEFORE SOLANA (Overlapping Base58 chars)
    if (/^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(input) || /^bc1[a-zA-Z0-9]{39,59}$/.test(input)) return 'wallet';
    
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input)) return 'wallet';

    return 'url';
}

function detectChain(input) {
    if (/^0x[a-fA-F0-9]{40}$/.test(input)) return 'ethereum';
    if (/^T[A-Za-z0-9]{33}$/.test(input)) return 'tron-like';
    if (/^[a-zA-Z0-9_-]{48}$/.test(input) || /^EQ[a-zA-Z0-9_-]{46}$/.test(input)) return 'ton-like';

    // BTC FIRST
    if (/^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(input) || /^bc1[a-zA-Z0-9]{39,59}$/.test(input)) return 'bitcoin-like';

    // SOLANA SECOND
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input)) return 'solana-like';

    return 'unknown';
}

module.exports = { detectType, detectChain };
