
// SC_SOL_CHAIN_LEN32_V6: base58 decode length (Solana pubkey/mint must decode to 32 bytes)
function _scB58DecodeLenDU(str){
  const ALPH='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let bytes=[0];
  for(let i=0;i<str.length;i++){
    const v=ALPH.indexOf(str[i]);
    if(v<0) return 0;
    let carry=v;
    for(let j=0;j<bytes.length;j++){
      carry += bytes[j]*58;
      bytes[j]=carry & 255;
      carry >>= 8;
    }
    while(carry>0){ bytes.push(carry & 255); carry >>= 8; }
  }
  for(let k=0;k<str.length && str[k]==='1';k++) bytes.push(0);
  return bytes.length;
}

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
    if (String(input || '') === '11111111111111111111111111111111') return 'solana-like'; // Solana System Program
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input)) {
  if (_scB58DecodeLenDU(String(input||'')) === 32) return 'solana-like'; // SC_SOL_CHAIN_LEN32_V7
}

    if (/^0x[a-fA-F0-9]{40}$/.test(input)) return 'ethereum';
    if (/^T[A-Za-z0-9]{33}$/.test(input)) return 'tron-like';
    if (/^[a-zA-Z0-9_-]{48}$/.test(input) || /^EQ[a-zA-Z0-9_-]{46}$/.test(input)) return 'ton-like';

    // BTC FIRST
    if (/^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(input) || /^bc1[a-zA-Z0-9]{39,59}$/.test(input)) return 'bitcoin-like';

    return 'unknown';
}

module.exports = { detectType, detectChain };
