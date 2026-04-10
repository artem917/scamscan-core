const axios = require('axios');
const { RPC_PROVIDERS } = require('../config/rpc');
const { id: keccakId } = require('ethers');

// ---------------- ETHERSCAN HISTORY (ETH only) ----------------

async function getEtherscanTransactions(address) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return null;
  try {
    const url =
      `https://api.etherscan.io/api` +
      `?module=account&action=txlist` +
      `&address=${address}` +
      `&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;
    const resp = await axios.get(url, { timeout: 6000 });
    if (resp.data && resp.data.status === '1' && Array.isArray(resp.data.result)) {
      return resp.data.result;
    }
    return [];
  } catch (e) {
    return null;
  }
}

function analyzeTxHistory(txs, address) {
  if (!txs || txs.length === 0) {
    return {
      txCount: 0,
      incoming: 0,
      outgoing: 0,
      uniqueSenders: 0,
      uniqueReceivers: 0,
      signals: []
    };
  }

  const addr = address.toLowerCase();
  let incoming = 0;
  let outgoing = 0;
  const senders = new Set();
  const receivers = new Set();

  for (const tx of txs) {
    const from = (tx.from || '').toLowerCase();
    const to = (tx.to || '').toLowerCase();

    if (to === addr) {
      incoming++;
      if (from) senders.add(from);
    }
    if (from === addr) {
      outgoing++;
      if (to) receivers.add(to);
    }
  }

  const signals = [];
  if (incoming > 0 && outgoing === 0) {
    signals.push('Wallet has only incoming transactions (possible deposit-only).');
  }

  return {
    txCount: txs.length,
    incoming,
    outgoing,
    uniqueSenders: senders.size,
    uniqueReceivers: receivers.size,
    signals
  };
}

// ---------------- GENERIC RPC WITH FALLBACK ----------------

async function callRpcWithFallback(chain, method, params = []) {
  const providers = RPC_PROVIDERS[chain] || [];
  if (!providers.length) {
    throw new Error(`No RPC providers configured for chain: ${chain}`);
  }

  let lastError;
  for (const url of providers) {
    try {
      const resp = await axios.post(
        url,
        { jsonrpc: '2.0', id: 1, method, params },
        { timeout: 10000 }
      );
      if (resp.data && Object.prototype.hasOwnProperty.call(resp.data, 'result')) {
        return resp.data.result;
      }
    } catch (e) {
      lastError = e;
      continue;
    }
  }
  throw lastError || new Error('All RPC providers failed');
}

async function callRpcDetailedWithFallback(chain, method, params = []) {
  const providers = RPC_PROVIDERS[chain] || [];
  if (!providers.length) {
    return { ok: false, errorCode: 'NO_RPC_PROVIDER', errorMessage: `No RPC providers configured for chain: ${chain}` };
  }

  let lastError = null;
  for (const url of providers) {
    try {
      const resp = await axios.post(
        url,
        { jsonrpc: '2.0', id: 1, method, params },
        { timeout: 10000, validateStatus: () => true }
      );
      const data = resp.data && typeof resp.data === 'object' ? resp.data : null;
      if (data && Object.prototype.hasOwnProperty.call(data, 'result')) {
        return { ok: true, provider: url, result: data.result };
      }
      if (data && data.error) {
        lastError = {
          ok: false,
          provider: url,
          errorCode: String(data.error.code || 'RPC_ERROR'),
          errorMessage: String(data.error.message || 'RPC error')
        };
      } else {
        lastError = {
          ok: false,
          provider: url,
          errorCode: 'RPC_EMPTY',
          errorMessage: 'RPC returned no result'
        };
      }
    } catch (e) {
      lastError = {
        ok: false,
        provider: url,
        errorCode: String((e && e.code) || 'RPC_EXCEPTION'),
        errorMessage: String((e && e.message) || e || 'RPC exception')
      };
    }
  }
  return lastError || { ok: false, errorCode: 'RPC_FAILED', errorMessage: 'All RPC providers failed' };
}

// Simple wrapper for eth_call
async function ethCallSimulate(chain, to, data) {
  return callRpcWithFallback(chain, 'eth_call', [{ to, data }, 'latest']);
}

async function ethCallDetailed(chain, tx, blockTag) {
  return callRpcDetailedWithFallback(chain, 'eth_call', [tx || {}, blockTag || 'latest']);
}

async function ethGetStorageAt(chain, address, slot) {
  return callRpcWithFallback(chain, 'eth_getStorageAt', [address, slot, 'latest']);
}

function parseAddressFromHexResult(hex) {
  try {
    const clean = String(hex || '').trim().replace(/^0x/, '').padStart(64, '0');
    const tail = clean.slice(-40);
    if (!/^0{40}$/i.test(tail) && /^[0-9a-fA-F]{40}$/.test(tail)) {
      return '0x' + tail.toLowerCase();
    }
  } catch (_) {}
  return null;
}

function parseBoolFromHexResult(hex) {
  try {
    const clean = String(hex || '').trim().replace(/^0x/, '');
    if (!clean) return null;
    return BigInt('0x' + clean) !== 0n;
  } catch (_) {}
  return null;
}

async function ethCallAddressProbe(chain, address, selector) {
  try {
    const raw = await ethCallSimulate(chain, address, selector);
    return parseAddressFromHexResult(raw);
  } catch (_) {
    return null;
  }
}

async function ethCallBoolProbe(chain, address, selector) {
  try {
    const raw = await ethCallSimulate(chain, address, selector);
    return parseBoolFromHexResult(raw);
  } catch (_) {
    return null;
  }
}

function hasSelectorInCode(codeHex, selector) {
  const code = String(codeHex || '').toLowerCase();
  const sel = String(selector || '').toLowerCase().replace(/^0x/, '');
  return !!(code && sel && code.includes(sel));
}

function parseStringFromHex(hex) {
  try {
    if (!hex || hex === '0x') return '';
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    let res = '';
    for (let i = 0; i < clean.length; i += 2) {
      const byte = parseInt(clean.substr(i, 2), 16);
      if (Number.isNaN(byte)) continue;
      if (byte >= 32 && byte <= 126) {
        res += String.fromCharCode(byte);
      }
    }
    return res.replace(/[^a-zA-Z0-9 \-\.]/g, '').trim();
  } catch (e) {
    return '';
  }
}

function encodeUint256Hex(value) {
  try {
    return BigInt(value).toString(16).padStart(64, '0');
  } catch (_) {
    return '0'.repeat(64);
  }
}

function encodeAddressParam(address) {
  const addr = normalizeEvmAddress(address);
  if (!addr) return '0'.repeat(64);
  return addr.replace(/^0x/, '').padStart(64, '0');
}

function encodeSelectorCall(selector, params) {
  const sel = String(selector || '').replace(/^0x/, '').toLowerCase();
  return '0x' + sel + ((params || []).join(''));
}

function toHexBlockTag(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '0x0';
  return '0x' + Math.floor(n).toString(16);
}

function buildSimulationProbeResult(raw) {
  if (raw && raw.ok) {
    return {
      ok: true,
      provider: raw.provider || null,
      errorCode: null,
      errorMessage: null
    };
  }
  return {
    ok: false,
    provider: raw && raw.provider ? raw.provider : null,
    errorCode: raw && raw.errorCode ? raw.errorCode : 'RPC_ERROR',
    errorMessage: raw && raw.errorMessage ? raw.errorMessage : 'RPC simulation failed'
  };
}

function getSourcifyChainId(chain) {
  const key = String(chain || '').toLowerCase().trim();
  if (key === 'ethereum') return 1;
  if (key === 'bsc') return 56;
  if (key === 'base') return 8453;
  return null;
}

function getExplorerApiConfig(chain) {
  const key = String(chain || '').toLowerCase().trim();
  if (key === 'ethereum') {
    return { chainId: 1, provider: 'etherscan_v2', apiKey: String(process.env.ETHERSCAN_API_KEY || '').trim() };
  }
  if (key === 'bsc') {
    return { chainId: 56, provider: 'bscscan_v2', apiKey: String(process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '').trim() };
  }
  if (key === 'base') {
    return { chainId: 8453, provider: 'basescan_v2', apiKey: String(process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '').trim() };
  }
  return null;
}

function normalizeEvmAddress(value) {
  const s = String(value || '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(s) ? s.toLowerCase() : null;
}

function safeParseAbi(abiRaw) {
  try {
    const parsed = JSON.parse(String(abiRaw || ''));
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function buildAbiFeatures(abiList) {
  const items = Array.isArray(abiList) ? abiList : [];
  const functionNames = items
    .filter((entry) => entry && entry.type === 'function' && entry.name)
    .map((entry) => String(entry.name).trim())
    .filter(Boolean);
  const nameSet = new Set(functionNames.map((name) => name.toLowerCase()));

  function hasAny(names) {
    return names.some((name) => nameSet.has(String(name).toLowerCase()));
  }

  return {
    functionNames,
    selectors: {
      owner: hasAny(['owner', 'getowner', 'admin']),
      pause: hasAny(['pause', 'setpause', 'setpaused']),
      unpause: hasAny(['unpause']),
      mint: hasAny(['mint', 'mintto', 'issue']),
      blacklist: hasAny(['addblacklist', 'blacklist', 'setblacklist', 'destroyblackfunds', 'freezeaccount', 'blockaccount']),
      setFee: hasAny(['setfee', 'setfees', 'setparams', 'settax', 'settaxfeepercent', 'setliquidityfeepercent']),
      burn: hasAny(['burn', 'burnfrom']),
      upgrade: hasAny(['upgrade', 'upgradeTo', 'upgradetoandcall', 'deprecate']),
      tradingControl: hasAny(['opentrading', 'enabletrading', 'settradingenabled', 'starttrading', 'setswapenabled']),
      walletLimits: hasAny(['setmaxwallet', 'setmaxwalletamount', 'setmaxwalletsize', 'setmaxholdings', 'setmaxtx', 'setmaxtransaction', 'setmaxtransactionamount', 'setmaxbuyamount', 'setmaxsellamount', 'removelimits']),
      whitelist: hasAny(['addwhitelist', 'whitelist', 'setwhitelist', 'excludefromfees', 'excludefrommaxtransaction', 'excludefromlimits']),
      rescue: hasAny(['rescuetokens', 'rescueerc20', 'withdrawstucketh', 'withdraweth', 'sweep', 'claimstucktokens']),
      routerControl: hasAny(['setrouter', 'setpair', 'setautomatedmarketmakerpair', 'setmarketmakerpair']),
      feeConfig: hasAny(['settaxfeepercent', 'setmarketingfee', 'setbuytax', 'setselltax', 'setliquidityfee', 'setfeeexempt']),
      cooldown: hasAny(['setcooldownenabled', 'setcooldowntime', 'settransferdelayenabled']),
      approvalControl: hasAny(['permit', 'permit2', 'increaseallowance', 'decreaseallowance', 'approveandcall', 'approvewithauthorization'])
    }
  };
}

function buildRoleAccessProfile(abiList, sourceText) {
  const items = Array.isArray(abiList) ? abiList : [];
  const src = String(sourceText || '');
  const srcLower = src.toLowerCase();
  const functionNames = items
    .filter((entry) => entry && entry.type === 'function' && entry.name)
    .map((entry) => String(entry.name).trim())
    .filter(Boolean);
  const lowered = functionNames.map((name) => name.toLowerCase());
  const hasFn = (names) => names.some((name) => lowered.includes(String(name).toLowerCase()));
  const hasAnyFragment = (fragments) => fragments.some((fragment) => lowered.some((name) => name.includes(String(fragment).toLowerCase())));
  const roleTokens = Array.from(new Set(
    Array.from(src.matchAll(/\b([A-Z0-9_]{3,}_ROLE)\b/g))
      .map((m) => String(m[1] || '').trim())
      .filter(Boolean)
  ));
  const hasToken = (patterns) => patterns.some((pattern) => roleTokens.includes(pattern));
  const usesAccessControl = hasFn(['grantRole', 'revokeRole', 'renounceRole', 'hasRole', 'getRoleAdmin', 'setRoleAdmin'])
    || srcLower.includes('accesscontrol')
    || roleTokens.length > 0
    || hasAnyFragment(['blacklister', 'pauser', 'masterminter', 'upgrader', 'controller', 'guardian']);

  const roles = [];
  const pushRole = (id, label, severity, details) => roles.push({ id, label, severity, details });

  if (hasToken(['DEFAULT_ADMIN_ROLE']) || hasFn(['grantRole', 'revokeRole', 'getRoleAdmin'])) {
    pushRole('default_admin_role', 'Default admin role', 'high', 'AccessControl-style admin role can grant, revoke, or supervise other privileged roles.');
  }
  if (
    hasToken(['PAUSER_ROLE']) ||
    (hasAnyFragment(['pause', 'unpause']) && srcLower.includes('role')) ||
    hasAnyFragment(['pauser', 'updatepauser'])
  ) {
    pushRole('pauser_role', 'Pauser role', 'medium', 'A dedicated pauser role can stop transfers or protocol actions without changing ownership.');
  }
  if (
    hasToken(['BLACKLISTER_ROLE', 'BLOCKLISTER_ROLE']) ||
    (hasAnyFragment(['blacklist', 'freeze']) && srcLower.includes('role')) ||
    hasAnyFragment(['blacklister', 'updateblacklister', 'isblacklisted'])
  ) {
    pushRole('blacklister_role', 'Blacklister role', 'high', 'A dedicated blacklister role can restrict selected addresses independently of owner checks.');
  }
  if (
    hasToken(['MINTER_ROLE']) ||
    (hasAnyFragment(['mint']) && srcLower.includes('role')) ||
    hasAnyFragment(['masterminter', 'configureminter', 'removeminter', 'isminter', 'minterallowed'])
  ) {
    pushRole('minter_role', 'Minter role', 'high', 'A dedicated minter role can increase supply without relying on a single owner function.');
  }
  if (
    hasToken(['UPGRADER_ROLE']) ||
    (hasAnyFragment(['upgrade']) && srcLower.includes('role')) ||
    hasAnyFragment(['upgrader', 'proxyadmin'])
  ) {
    pushRole('upgrader_role', 'Upgrader role', 'high', 'An upgrader role can replace implementation logic through role-gated flows.');
  }
  if (hasToken(['OPERATOR_ROLE', 'CONTROLLER_ROLE', 'GOVERNOR_ROLE', 'GUARDIAN_ROLE'])) {
    pushRole('operator_role', 'Operator / controller role', 'medium', 'Non-owner privileged roles are present and should be reviewed with the admin graph.');
  }

  return {
    checked: !!src || items.length > 0,
    usesAccessControl,
    roleTokens,
    adminFunctions: {
      grantRole: hasFn(['grantRole']),
      revokeRole: hasFn(['revokeRole']),
      renounceRole: hasFn(['renounceRole']),
      hasRole: hasFn(['hasRole']),
      getRoleAdmin: hasFn(['getRoleAdmin']),
      setRoleAdmin: hasFn(['setRoleAdmin'])
    },
    roles
  };
}

function buildPrivilegeMap(abiList, sourceText) {
  const items = Array.isArray(abiList) ? abiList : [];
  const src = String(sourceText || '');
  const lowered = src.toLowerCase();
  if (!src || !items.length) {
    return {
      checked: !!src || items.length > 0,
      entries: [],
      summary: {
        ownerOnlyCount: 0,
        roleGatedCount: 0,
        customGatedCount: 0
      }
    };
  }

  const sensitive = new Map([
    ['pause', 'pause'],
    ['unpause', 'unpause'],
    ['grantrole', 'grant_role'],
    ['revokerole', 'revoke_role'],
    ['renouncerole', 'renounce_role'],
    ['transferownership', 'transfer_ownership'],
    ['upgradeto', 'upgrade_to'],
    ['upgradetoandcall', 'upgrade_to_and_call'],
    ['blacklist', 'blacklist'],
    ['setblacklist', 'blacklist'],
    ['addblacklist', 'blacklist'],
    ['batchsetblacklist', 'blacklist'],
    ['settradingenabled', 'trading_control'],
    ['enabletrading', 'trading_control'],
    ['opentrading', 'trading_control'],
    ['starttrading', 'trading_control'],
    ['setrouter', 'router_control'],
    ['setpair', 'router_control'],
    ['setautomatedmarketmakerpair', 'router_control'],
    ['setmarketmakerpair', 'router_control'],
    ['settax', 'fee_config'],
    ['settaxfeepercent', 'fee_config'],
    ['setbuytax', 'fee_config'],
    ['setselltax', 'fee_config'],
    ['setfee', 'fee_config'],
    ['setfees', 'fee_config'],
    ['setliquidityfee', 'fee_config'],
    ['setmarketingfee', 'fee_config'],
    ['rescuetokens', 'rescue'],
    ['rescueerc20', 'rescue'],
    ['withdrawtoken', 'rescue'],
    ['withdrawusdt', 'rescue'],
    ['withdraweth', 'rescue'],
    ['claimstucktokens', 'rescue'],
    ['mint', 'mint'],
    ['configureminter', 'mint'],
    ['removeminter', 'mint']
  ]);

  const entries = [];
  const summary = { ownerOnlyCount: 0, roleGatedCount: 0, customGatedCount: 0 };

  for (const entry of items) {
    if (!entry || entry.type !== 'function' || !entry.name) continue;
    const fnName = String(entry.name || '').trim();
    const fnLow = fnName.toLowerCase();
    const category = sensitive.get(fnLow);
    if (!category) continue;

    const fnPattern = new RegExp(`function\\s+${fnName}\\s*\\([^\\)]*\\)\\s*([^\\{;\\n]*)`, 'i');
    const match = src.match(fnPattern);
    const suffix = String((match && match[1]) || '').trim();
    const suffixLower = suffix.toLowerCase();
    let gate = 'unknown';
    let gateLabel = 'Unknown access gate';

    if (suffixLower.includes('onlyowner')) {
      gate = 'only_owner';
      gateLabel = 'onlyOwner';
      summary.ownerOnlyCount += 1;
    } else {
      const roleMatch = suffix.match(/onlyRole\s*\(([^)]+)\)/i);
      if (roleMatch) {
        gate = 'only_role';
        gateLabel = compactRoleLabel(roleMatch[1]);
        summary.roleGatedCount += 1;
      } else {
        const tokenMatch = suffix.match(/\bonly([A-Za-z0-9_]+)/);
        if (tokenMatch) {
          gate = 'custom_gate';
          gateLabel = 'only' + tokenMatch[1];
          summary.customGatedCount += 1;
        } else if (suffixLower.includes('requiresauth') || suffixLower.includes('auth')) {
          gate = 'custom_gate';
          gateLabel = 'custom auth gate';
          summary.customGatedCount += 1;
        }
      }
    }

    entries.push({
      functionName: fnName,
      category,
      gate,
      gateLabel
    });
  }

  return {
    checked: true,
    entries,
    summary
  };
}

function compactRoleLabel(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return 'onlyRole';
  return raw.replace(/\s+/g, ' ').slice(0, 60);
}

function buildDangerousPatterns(abiFeatures, sourceIndicators, sourceText) {
  const names = Array.isArray(abiFeatures && abiFeatures.functionNames) ? abiFeatures.functionNames : [];
  const lowered = names.map((name) => String(name || '').toLowerCase()).filter(Boolean);
  const src = String(sourceText || '').toLowerCase();
  const selectors = (abiFeatures && abiFeatures.selectors) || {};
  const indicators = sourceIndicators || {};

  const hasFn = (patterns) => patterns.some((pattern) => lowered.some((name) => name === pattern || name.includes(pattern)));
  const out = [];
  const push = (id, label, severity, details) => out.push({ id, label, severity, details });

  if (selectors.blacklist || indicators.blacklist) {
    if (hasFn(['batchsetblacklist', 'setblacklist', 'blacklist', 'destroyblackfunds', 'freezeaccount', 'blockaccount'])) {
      push('address_blacklist', 'Address blacklist controls', 'high', 'Verified source exposes address blacklist or freeze-style functions.');
    }
  }

  if (selectors.whitelist || indicators.whitelist) {
    if (hasFn(['batchsetwhitelist', 'setwhitelist', 'whitelist', 'excludefromfee', 'exclude'])) {
      push('address_whitelist', 'Whitelist / exclusions', 'medium', 'Verified source exposes whitelist or exclusion controls.');
    }
  }

  if (selectors.tradingControl || indicators.tradingControl) {
    if (hasFn(['settradingenabled', 'enabletrading', 'opentrading', 'starttrading', 'tradingenabled'])) {
      push('trading_toggle', 'Trading toggle', 'high', 'Verified source exposes a launch or trading enable/disable control.');
    }
  }

  if (selectors.feeConfig || indicators.feeConfig || selectors.setFee) {
    if (hasFn(['settax', 'settaxfeepercent', 'setbuytax', 'setselltax', 'setmarketingfee', 'setliquidityfee', 'setfeereceiver', 'feereceiver'])) {
      push('fee_admin', 'Owner-controlled fee settings', 'high', 'Verified source exposes owner-controlled fee or tax configuration.');
    }
  }

  if (selectors.routerControl || indicators.routerControl) {
    if (hasFn(['setrouter', 'setpair', 'setautomatedmarketmakerpair', 'setmarketmakerpair'])) {
      push('router_admin', 'Router / pair admin', 'high', 'Verified source exposes router or market-pair configuration controls.');
    }
  }

  if (selectors.rescue || indicators.rescue || src.includes('withdraw')) {
    if (hasFn(['withdrawtoken', 'withdrawusdt', 'withdraweth', 'rescuetokens', 'rescueerc20', 'sweep', 'claimstucktokens'])) {
      push('owner_withdraw', 'Owner withdraw / rescue', 'high', 'Verified source exposes owner withdraw or rescue functions.');
    }
  }

  if (selectors.walletLimits || indicators.walletLimits) {
    if (hasFn(['setmaxwallet', 'setmaxtransaction', 'setmaxbuyamount', 'setmaxsellamount', 'removelimits'])) {
      push('wallet_limits', 'Wallet / tx limits', 'medium', 'Verified source exposes max-wallet or max-transaction limit controls.');
    }
  }

  if (selectors.cooldown || indicators.cooldown) {
    if (hasFn(['setcooldownenabled', 'setcooldowntime', 'settransferdelayenabled'])) {
      push('cooldown_delay', 'Cooldown / transfer delay', 'medium', 'Verified source exposes cooldown or transfer-delay controls.');
    }
  }

  if (selectors.approvalControl || indicators.approvalControl) {
    if (hasFn(['permit', 'approveandcall', 'approvewithauthorization', 'increaseallowance', 'decreaseallowance'])) {
      push('approval_helpers', 'Approval / permit helpers', 'medium', 'Verified source exposes non-trivial approval or permit-style helpers.');
    }
  }

  return out;
}

function buildSourceIndicators(sourceText) {
  const src = String(sourceText || '').toLowerCase();
  if (!src) {
    return {
      tradingControl: false,
      walletLimits: false,
      whitelist: false,
      blacklist: false,
      feeConfig: false,
      rescue: false,
      routerControl: false,
      cooldown: false,
      approvalControl: false
    };
  }

  const hasAny = (patterns) => patterns.some((pattern) => src.includes(pattern));
  return {
    tradingControl: hasAny(['tradingenabled', 'opentrading', 'enabletrading', 'starttrading', 'swapenabled']),
    walletLimits: hasAny(['maxwallet', 'maxwalletamount', 'maxwalletsize', 'maxtransactionamount', 'maxtx', 'maxbuyamount', 'maxsellamount', 'maxholding', 'removelimits']),
    whitelist: hasAny(['whitelist', 'isexcludedfromfee', 'excludedfromfee', 'excludedfrommaxtransaction', 'excludedfromlimits']),
    blacklist: hasAny(['blacklist', 'blacklisted', 'isblacklisted', 'bots', 'snipers']),
    feeConfig: hasAny(['taxfee', 'marketingfee', 'liquidityfee', 'buytax', 'selltax', 'setfee', 'setfees']),
    rescue: hasAny(['withdrawstuck', 'withdraweth', 'rescuetoken', 'claimstuck', 'sweep']),
    routerControl: hasAny(['setrouter', 'setpair', 'automatedmarketmakerpairs', 'setautomatedmarketmakerpair', 'uniswapv2router']),
    cooldown: hasAny(['cooldown', 'transferdelay', 'deadblocks', 'launchblock']),
    approvalControl: hasAny(['permit(', 'permit2', 'approveandcall', 'increaseallowance', 'decreaseallowance', 'approvewithauthorization'])
  };
}

function mergeControlIndicators(sourceCode) {
  const abiSelectors = (sourceCode && sourceCode.abiFeatures && sourceCode.abiFeatures.selectors) || {};
  const srcIndicators = (sourceCode && sourceCode.sourceIndicators) || {};
  return {
    owner: !!abiSelectors.owner,
    pause: !!abiSelectors.pause,
    unpause: !!abiSelectors.unpause,
    mint: !!abiSelectors.mint,
    blacklist: !!(abiSelectors.blacklist || srcIndicators.blacklist),
    setFee: !!(abiSelectors.setFee || abiSelectors.feeConfig || srcIndicators.feeConfig),
    burn: !!abiSelectors.burn,
    upgrade: !!abiSelectors.upgrade,
    tradingControl: !!(abiSelectors.tradingControl || srcIndicators.tradingControl),
    walletLimits: !!(abiSelectors.walletLimits || srcIndicators.walletLimits),
    whitelist: !!(abiSelectors.whitelist || srcIndicators.whitelist),
    rescue: !!(abiSelectors.rescue || srcIndicators.rescue),
    routerControl: !!(abiSelectors.routerControl || srcIndicators.routerControl),
    cooldown: !!(abiSelectors.cooldown || srcIndicators.cooldown),
    feeConfig: !!(abiSelectors.feeConfig || srcIndicators.feeConfig),
    approvalControl: !!(abiSelectors.approvalControl || srcIndicators.approvalControl)
  };
}

function classifySimulationFailure(errorMessage) {
  const msg = String(errorMessage || '').toLowerCase();
  if (!msg) return 'technical_error';
  if (msg.includes('blacklist') || msg.includes('not allowed')) return 'blacklist_or_permission';
  if (msg.includes('trading') || msg.includes('trade') || msg.includes('launch')) return 'trading_gate';
  if (msg.includes('maxwallet') || msg.includes('max wallet')) return 'wallet_limit';
  if (msg.includes('maxtx') || msg.includes('max tx') || msg.includes('maxtransaction')) return 'tx_limit';
  if (msg.includes('paused')) return 'paused';
  if (msg.includes('insufficient') || msg.includes('balance')) return 'balance_or_state';
  return 'technical_error';
}

function simulationWarning(prefix, category, fallback) {
  if (category === 'blacklist_or_permission') return prefix + ' reverted with a blacklist or permission-style restriction.';
  if (category === 'trading_gate') return prefix + ' reverted with a trading gate or launch restriction.';
  if (category === 'wallet_limit') return prefix + ' reverted with a max-wallet style restriction.';
  if (category === 'tx_limit') return prefix + ' reverted with a max-transaction or sell limit.';
  if (category === 'paused') return prefix + ' reverted because the token appears paused.';
  if (category === 'balance_or_state') return prefix + ' reverted because the token requires a different holder or balance state for this probe.';
  return fallback;
}

async function fetchSourcifySourceCode(chain, address) {
  const chainId = getSourcifyChainId(chain);
  const addr = String(address || '').trim();
  if (!chainId || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return null;

  const base = `https://repo.sourcify.dev/contracts`;
  const variants = [
    { matchType: 'full_match', verified: true },
    { matchType: 'partial_match', verified: true }
  ];

  for (const variant of variants) {
    try {
      const url = `${base}/${variant.matchType}/${chainId}/${addr}/metadata.json`;
      const resp = await axios.get(url, {
        timeout: 5000,
        maxRedirects: 3,
        validateStatus: () => true
      });
      if (resp.status === 200) {
        const metadata = resp.data && typeof resp.data === 'object' ? resp.data : null;
        const compilerVersion = metadata && typeof metadata.compiler === 'object'
          ? String(metadata.compiler.version || '').trim() || null
          : null;
        const language = metadata && typeof metadata.language === 'string'
          ? metadata.language
          : null;
        return {
          checked: true,
          verified: variant.verified,
          provider: 'sourcify',
          matchType: variant.matchType,
          chainId,
          compilerVersion,
          language
        };
      }
      if (resp.status !== 404) {
        return {
          checked: true,
          verified: null,
          provider: 'sourcify',
          matchType: null,
          chainId,
          error: 'HTTP_' + String(resp.status || 'UNKNOWN')
        };
      }
    } catch (_) {
      continue;
    }
  }

  return {
    checked: true,
    verified: false,
    provider: 'sourcify',
    matchType: null,
    chainId
  };
}

async function fetchExplorerSourceCode(chain, address) {
  const cfg = getExplorerApiConfig(chain);
  const addr = String(address || '').trim();
  if (!cfg || !cfg.apiKey || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return null;

  try {
    const resp = await axios.get('https://api.etherscan.io/v2/api', {
      timeout: 7000,
      maxRedirects: 3,
      validateStatus: () => true,
      params: {
        chainid: cfg.chainId,
        module: 'contract',
        action: 'getsourcecode',
        address: addr,
        apikey: cfg.apiKey
      }
    });

    const data = resp.data && typeof resp.data === 'object' ? resp.data : null;
    const row = data && Array.isArray(data.result) ? data.result[0] : null;
    if (!data || !row || typeof row !== 'object') return null;

    const sourceCode = String(row.SourceCode || '').trim();
    const abi = String(row.ABI || '').trim();
    const contractName = String(row.ContractName || '').trim() || null;
    const compilerVersion = String(row.CompilerVersion || '').trim() || null;
    const licenseType = String(row.LicenseType || '').trim() || null;
    const implementation = String(row.Implementation || '').trim() || null;
    const proxyDetected = String(row.Proxy || '').trim() === '1';
    const verified = !!sourceCode || (!!abi && abi !== 'Contract source code not verified');
    const abiJson = verified ? safeParseAbi(abi) : null;
    const abiFeatures = buildAbiFeatures(abiJson);
    const sourceIndicators = verified ? buildSourceIndicators(sourceCode) : null;
    const roleAccess = verified ? buildRoleAccessProfile(abiJson, sourceCode) : null;
    const dangerousPatterns = verified ? buildDangerousPatterns(abiFeatures, sourceIndicators, sourceCode) : [];
    const privilegeMap = verified ? buildPrivilegeMap(abiJson, sourceCode) : null;

    return {
      checked: true,
      verified,
      provider: cfg.provider,
      matchType: verified ? 'explorer_verified' : null,
      chainId: cfg.chainId,
      compilerVersion,
      contractName,
      licenseType,
      implementation: implementation || null,
      proxyDetected,
      abiJson,
      abiFeatures,
      sourceIndicators,
      roleAccess,
      dangerousPatterns,
      privilegeMap
    };
  } catch (_) {
    return null;
  }
}

async function fetchBestSourceCode(chain, address) {
  const [sourcify, explorer] = await Promise.all([
    fetchSourcifySourceCode(chain, address).catch(() => null),
    fetchExplorerSourceCode(chain, address).catch(() => null)
  ]);

  const primary = (sourcify && sourcify.verified) ? sourcify
    : (explorer && explorer.verified) ? explorer
    : (sourcify && sourcify.checked) ? sourcify
    : (explorer && explorer.checked) ? explorer
    : (sourcify || explorer || null);
  if (!primary) return null;

  const secondary = primary === sourcify ? explorer : sourcify;
  const merged = Object.assign({}, primary);
  if (secondary && typeof secondary === 'object') {
    if (!merged.provider) merged.provider = secondary.provider || null;
    else if (secondary.provider && merged.provider !== secondary.provider) merged.provider = merged.provider + '+' + secondary.provider;
    if (!merged.matchType && secondary.matchType) merged.matchType = secondary.matchType;
    if (!merged.contractName && secondary.contractName) merged.contractName = secondary.contractName;
    if (!merged.compilerVersion && secondary.compilerVersion) merged.compilerVersion = secondary.compilerVersion;
    if (!merged.licenseType && secondary.licenseType) merged.licenseType = secondary.licenseType;
    if (!merged.implementation && secondary.implementation) merged.implementation = secondary.implementation;
    if (!merged.proxyDetected && secondary.proxyDetected) merged.proxyDetected = true;
    if (!merged.abiJson && secondary.abiJson) merged.abiJson = secondary.abiJson;
    if ((!merged.abiFeatures || !merged.abiFeatures.selectors) && secondary.abiFeatures) merged.abiFeatures = secondary.abiFeatures;
    if ((!merged.roleAccess || !merged.roleAccess.checked) && secondary.roleAccess) merged.roleAccess = secondary.roleAccess;
    if ((!merged.dangerousPatterns || !merged.dangerousPatterns.length) && secondary.dangerousPatterns) merged.dangerousPatterns = secondary.dangerousPatterns;
    if ((!merged.privilegeMap || !merged.privilegeMap.checked) && secondary.privilegeMap) merged.privilegeMap = secondary.privilegeMap;
    if (secondary.verified) merged.verified = true;
    if (secondary.checked) merged.checked = true;
  }
  return merged;
}

async function fetchExplorerHolderSummary(chain, address, tokenMeta) {
  const cfg = getExplorerApiConfig(chain);
  const addr = normalizeEvmAddress(address);
  if (!cfg || !cfg.apiKey || !addr) return null;

  const out = {
    checked: true,
    provider: cfg.provider,
    holderCount: null,
    top1Pct: null,
    top5Pct: null,
    concentrationChecked: false,
    unavailableReason: null
  };

  try {
    const countResp = await axios.get('https://api.etherscan.io/v2/api', {
      timeout: 7000,
      maxRedirects: 3,
      validateStatus: () => true,
      params: {
        chainid: cfg.chainId,
        module: 'token',
        action: 'tokenholdercount',
        contractaddress: addr,
        apikey: cfg.apiKey
      }
    });

    const countData = countResp.data && typeof countResp.data === 'object' ? countResp.data : null;
    const countResult = countData ? String(countData.result || '').trim() : '';
    if (countData && countData.status === '1' && /^\d+$/.test(countResult)) {
      out.holderCount = Number(countResult);
    } else if (countResult && /free api access is not supported/i.test(countResult)) {
      out.unavailableReason = 'paid_plan_required';
    }
  } catch (_) {}

  const totalSupplyRaw = tokenMeta && tokenMeta.totalSupply ? String(tokenMeta.totalSupply) : '';
  if (!/^\d+$/.test(totalSupplyRaw) || totalSupplyRaw === '0') {
    return out;
  }

  try {
    const topResp = await axios.get('https://api.etherscan.io/v2/api', {
      timeout: 7000,
      maxRedirects: 3,
      validateStatus: () => true,
      params: {
        chainid: cfg.chainId,
        module: 'token',
        action: 'topholders',
        contractaddress: addr,
        offset: 5,
        apikey: cfg.apiKey
      }
    });
    const topData = topResp.data && typeof topResp.data === 'object' ? topResp.data : null;
    const topRows = topData && Array.isArray(topData.result) ? topData.result : null;
    if (topData && topData.status === '1' && topRows && topRows.length) {
      const totalSupply = Number(totalSupplyRaw);
      if (Number.isFinite(totalSupply) && totalSupply > 0) {
        const quantities = topRows
          .map((row) => Number(String(row.TokenHolderQuantity || '').trim()))
          .filter((value) => Number.isFinite(value) && value >= 0);
        if (quantities.length) {
          const top1 = quantities[0] || 0;
          const top5 = quantities.reduce((sum, value) => sum + value, 0);
          out.top1Pct = (top1 / totalSupply) * 100;
          out.top5Pct = (top5 / totalSupply) * 100;
          out.concentrationChecked = true;
        }
      }
    } else {
      const resultText = topData ? String(topData.result || '').trim() : '';
      if (resultText && /free api access is not supported/i.test(resultText)) {
        out.unavailableReason = out.unavailableReason || 'paid_plan_required';
      }
    }
  } catch (_) {}

  return out;
}

async function fetchRecentGovernanceEvents(chain, address) {
  const addr = normalizeEvmAddress(address);
  if (!addr || !['ethereum', 'bsc', 'base'].includes(String(chain || '').toLowerCase().trim())) return null;

  try {
    const latestHex = await callRpcWithFallback(chain, 'eth_blockNumber', []);
    const latestBlock = parseInt(String(latestHex || '0x0'), 16);
    if (!Number.isFinite(latestBlock) || latestBlock < 1) return null;
    const window = String(chain || '').toLowerCase().trim() === 'bsc' ? 150000 : 75000;
    const fromBlock = Math.max(0, latestBlock - window);
    const topics = [
      { id: 'ownership_transferred', topic: keccakId('OwnershipTransferred(address,address)') },
      { id: 'paused', topic: keccakId('Paused(address)') },
      { id: 'unpaused', topic: keccakId('Unpaused(address)') },
      { id: 'upgraded', topic: keccakId('Upgraded(address)') },
      { id: 'admin_changed', topic: keccakId('AdminChanged(address,address)') },
      { id: 'role_granted', topic: keccakId('RoleGranted(bytes32,address,address)') },
      { id: 'role_revoked', topic: keccakId('RoleRevoked(bytes32,address,address)') }
    ];
    const counts = {};
    let checked = false;
    let latestSeenBlock = null;

    await Promise.all(topics.map(async (item) => {
      try {
        const logs = await callRpcWithFallback(chain, 'eth_getLogs', [{
          address: addr,
          fromBlock: toHexBlockTag(fromBlock),
          toBlock: toHexBlockTag(latestBlock),
          topics: [item.topic]
        }]);
        if (Array.isArray(logs)) {
          checked = true;
          counts[item.id] = logs.length;
          for (const log of logs) {
            const blockNo = parseInt(String(log && log.blockNumber || '0x0'), 16);
            if (Number.isFinite(blockNo) && (latestSeenBlock === null || blockNo > latestSeenBlock)) latestSeenBlock = blockNo;
          }
        }
      } catch (_) {}
    }));

    const totalEvents = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    if (!checked) return null;
    return {
      checked: true,
      provider: 'rpc_logs',
      lookbackBlocks: latestBlock - fromBlock,
      latestBlock,
      latestSeenBlock,
      totalEvents,
      counts,
      hasUpgradeHistory: Number(counts.upgraded || 0) > 0 || Number(counts.admin_changed || 0) > 0,
      hasPauseHistory: Number(counts.paused || 0) > 0 || Number(counts.unpaused || 0) > 0,
      hasRoleHistory: Number(counts.role_granted || 0) > 0 || Number(counts.role_revoked || 0) > 0,
      hasOwnershipHistory: Number(counts.ownership_transferred || 0) > 0
    };
  } catch (_) {
    return null;
  }
}

async function fetchDexLiquiditySummary(chain, address) {
  const chainKey = String(chain || '').toLowerCase().trim();
  const addr = String(address || '').trim();
  if (!['ethereum', 'bsc', 'base'].includes(chainKey) || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return null;

  try {
    const resp = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, {
      timeout: 7000,
      maxRedirects: 2,
      validateStatus: () => true
    });
    const data = resp.data && typeof resp.data === 'object' ? resp.data : null;
    const pairs = data && Array.isArray(data.pairs) ? data.pairs : [];
    const filtered = pairs.filter((pair) => pair && String(pair.chainId || '').toLowerCase() === chainKey);
    if (!filtered.length) {
      return { checked: true, found: false, provider: 'dexscreener', chain: chainKey };
    }

    const sorted = filtered.slice().sort((a, b) => {
      const la = Number(a && a.liquidity && a.liquidity.usd) || 0;
      const lb = Number(b && b.liquidity && b.liquidity.usd) || 0;
      return lb - la;
    });
    const top = sorted[0] || {};
    const liquidityUsd = Number(top && top.liquidity && top.liquidity.usd);
    const fdv = Number(top && top.fdv);
    const marketCap = Number(top && top.marketCap);

    return {
      checked: true,
      found: true,
      provider: 'dexscreener',
      chain: chainKey,
      dexId: String(top.dexId || '').trim() || null,
      pairAddress: String(top.pairAddress || '').trim() || null,
      url: String(top.url || '').trim() || null,
      liquidityUsd: Number.isFinite(liquidityUsd) ? liquidityUsd : null,
      fdv: Number.isFinite(fdv) ? fdv : null,
      marketCap: Number.isFinite(marketCap) ? marketCap : null,
      quoteSymbol: top && top.quoteToken ? String(top.quoteToken.symbol || '').trim() || null : null,
      pairCreatedAt: Number.isFinite(Number(top.pairCreatedAt)) ? Number(top.pairCreatedAt) : null
    };
  } catch (_) {
    return null;
  }
}

// ---------------- HONEYPOT / CONTRACT CHECK ----------------

async function checkHoneypot(chain, address) {
  try {
    const code = await callRpcWithFallback(chain, 'eth_getCode', [address, 'latest']);

    // Любой "пустой" код (0x, 0x0, 0x0000...) считаем EOA, а не контракт
    if (!code || /^0x0*$/.test(code)) {
      return { isContract: false, codeSize: 0, isHoneypot: false, flags: [] };
    }

    const result = {
      isContract: true,
      codeSize: code.length,
      isHoneypot: false,
      flags: []
    };

    // Проба стандартного ERC20 totalSupply()
    try {
      await ethCallSimulate(chain, address, '0x18160ddd');
    } catch (e) {
      result.flags.push('NOT_STD_ERC20');
    }

    // Проба transfer(to=0xdead, amount=0) — ловим простые honeypot-ограничения
    const method = '0xa9059cbb';
    const toParam = '000000000000000000000000000000000000dead';
    const amountParam = '0000000000000000000000000000000000000000000000000000000000000000';

    try {
      await ethCallSimulate(chain, address, method + toParam + amountParam);
    } catch (e) {
      // v1: simulation error is logged as a flag but не приговаривает контракт к honeypot
      result.flags.push('TRANSFER_SIMULATION_FAILED');
    }

    return result;
  } catch (e) {
    return {
      isContract: false,
      codeSize: 0,
      isHoneypot: false,
      flags: ['RPC_FAIL']
    };
  }
}

async function simulateTradingPaths(chain, address, context) {
  const market = (context && typeof context === 'object') ? context : {};
  const pairAddress = normalizeEvmAddress(market.pairAddress);
  const controlHints = (market.contractControl && market.contractControl.selectors) || {};
  const zeroAmount = encodeUint256Hex(0n);
  const dummyFrom = '0x000000000000000000000000000000000000dEaD';

  const result = {
    checked: true,
    beta: true,
    flags: [],
    warnings: [],
    riskScore: 0,
    probes: {}
  };

  const totalSupplyProbe = buildSimulationProbeResult(await ethCallDetailed(chain, { to: address, data: '0x18160ddd' }));
  result.probes.totalSupply = totalSupplyProbe;
  if (!totalSupplyProbe.ok) {
    result.flags.push('NOT_STD_ERC20');
  }

  const genericTransfer = buildSimulationProbeResult(await ethCallDetailed(chain, {
    from: dummyFrom,
    to: address,
    data: encodeSelectorCall('0xa9059cbb', [encodeAddressParam(dummyFrom), zeroAmount])
  }));
  result.probes.transfer = genericTransfer;
  if (!genericTransfer.ok) {
    result.flags.push('TRANSFER_SIMULATION_FAILED');
    const category = classifySimulationFailure(genericTransfer.errorMessage);
    result.warnings.push(simulationWarning(
      'Generic transfer probe',
      category,
      'Generic transfer simulation failed (beta: transfer restrictions or a non-standard token path may exist).'
    ));
    result.riskScore = Math.max(result.riskScore, category === 'trading_gate' || category === 'blacklist_or_permission' ? 75 : 60);
  }

  const genericApprove = buildSimulationProbeResult(await ethCallDetailed(chain, {
    from: dummyFrom,
    to: address,
    data: encodeSelectorCall('0x095ea7b3', [encodeAddressParam(dummyFrom), zeroAmount])
  }));
  result.probes.approve = genericApprove;
  if (!genericApprove.ok) {
    result.flags.push('APPROVE_SIMULATION_FAILED');
    const category = classifySimulationFailure(genericApprove.errorMessage);
    result.warnings.push(simulationWarning(
      'Approve probe',
      category,
      'Approve simulation failed (beta: the token path is behaving non-standardly for a plain ERC20 approval).'
    ));
    result.riskScore = Math.max(result.riskScore, category === 'blacklist_or_permission' ? 75 : 60);
  }

  if (pairAddress) {
      const sellProbe = buildSimulationProbeResult(await ethCallDetailed(chain, {
        from: dummyFrom,
        to: address,
        data: encodeSelectorCall('0xa9059cbb', [encodeAddressParam(pairAddress), zeroAmount])
      }));
    result.probes.sellRoute = sellProbe;
    if (!sellProbe.ok) {
      result.flags.push('SELL_ROUTE_SIMULATION_FAILED');
      const category = classifySimulationFailure(sellProbe.errorMessage);
      result.warnings.push(simulationWarning(
        'Sell-style transfer probe to the live pair',
        category,
        'Sell-style transfer simulation to the live pair failed (beta: potential sell or trading restrictions).'
      ));
      result.riskScore = Math.max(result.riskScore, genericTransfer.ok ? 80 : 70);
    } else if (!genericTransfer.ok) {
      result.warnings.push('Generic transfer probe failed, but the sell-style transfer to the live pair did not. This often points to a non-standard transfer implementation rather than a confirmed honeypot.');
      result.riskScore = Math.max(result.riskScore, 45);
    }
  }

  if (controlHints.tradingControl) {
    result.flags.push('TRADING_CONTROL_FUNCTIONS_PRESENT');
    result.warnings.push('Verified ABI/source indicates trading-enable or launch-gate controls.');
    result.riskScore = Math.max(result.riskScore, 55);
  }
  if (controlHints.walletLimits) {
    result.flags.push('WALLET_LIMIT_FUNCTIONS_PRESENT');
    result.warnings.push('Verified ABI/source indicates max-wallet or max-transaction limit controls.');
    result.riskScore = Math.max(result.riskScore, 50);
  }
  if (controlHints.blacklist || controlHints.whitelist) {
    result.flags.push('ADDRESS_GATING_FUNCTIONS_PRESENT');
    result.warnings.push('Verified ABI/source indicates blacklist, whitelist, or address-gating controls.');
    result.riskScore = Math.max(result.riskScore, 60);
  }
  if (controlHints.feeConfig) {
    result.flags.push('FEE_CONFIGURATION_PRESENT');
    result.warnings.push('Verified ABI/source indicates owner-controlled fee or tax configuration.');
    result.riskScore = Math.max(result.riskScore, 45);
  }
  if (controlHints.cooldown) {
    result.flags.push('COOLDOWN_CONTROLS_PRESENT');
    result.warnings.push('Verified ABI/source indicates cooldown or transfer-delay controls.');
    result.riskScore = Math.max(result.riskScore, 45);
  }
  if (controlHints.rescue) {
    result.flags.push('RESCUE_WITHDRAW_PRESENT');
  }

  result.isHoneypot = !!(
    (result.flags.includes('SELL_ROUTE_SIMULATION_FAILED') && genericTransfer.ok) ||
    (result.flags.includes('TRANSFER_SIMULATION_FAILED') && result.flags.includes('APPROVE_SIMULATION_FAILED'))
  );

  return result;
}

async function getContractControl(chain, address, options) {
  try {
    const opts = (options && typeof options === 'object') ? options : {};
    const depth = Number.isFinite(Number(opts.depth)) ? Number(opts.depth) : 0;
    const maxDepth = Number.isFinite(Number(opts.maxDepth)) ? Number(opts.maxDepth) : 1;
    const seen = opts.seen instanceof Set ? new Set(opts.seen) : new Set();
    const selfAddress = normalizeEvmAddress(address);
    if (selfAddress) {
      if (seen.has(selfAddress)) return null;
      seen.add(selfAddress);
    }

    const [code, sourceCode] = await Promise.all([
      callRpcWithFallback(chain, 'eth_getCode', [address, 'latest']).catch(() => null),
      fetchBestSourceCode(chain, address).catch(() => null)
    ]);
    if (!code || /^0x0*$/i.test(String(code))) {
      if (sourceCode && sourceCode.verified) {
        const explorerSelectors = mergeControlIndicators(sourceCode);
        return {
          codeSize: 0,
          ownerAddress: null,
          paused: null,
          proxy: {
            implementation: String(sourceCode.implementation || '').trim() || null,
            admin: null,
            detected: !!(sourceCode.proxyDetected || sourceCode.implementation)
          },
          selectors: {
            owner: !!explorerSelectors.owner,
            pause: !!explorerSelectors.pause,
            unpause: !!explorerSelectors.unpause,
            mint: !!explorerSelectors.mint,
            blacklist: !!explorerSelectors.blacklist,
            setFee: !!explorerSelectors.setFee,
            burn: !!explorerSelectors.burn,
            upgrade: !!explorerSelectors.upgrade,
            tradingControl: !!explorerSelectors.tradingControl,
            walletLimits: !!explorerSelectors.walletLimits,
            whitelist: !!explorerSelectors.whitelist,
            rescue: !!explorerSelectors.rescue,
            routerControl: !!explorerSelectors.routerControl,
            cooldown: !!explorerSelectors.cooldown,
            feeConfig: !!explorerSelectors.feeConfig,
            approvalControl: !!explorerSelectors.approvalControl
          },
          sourceCode
        };
      }
      return null;
    }

    const EIP1967_IMPLEMENTATION_SLOT = '0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC';
    const EIP1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

    const [ownerAddress, paused, implementationSlotRaw, adminSlotRaw, recentEvents] = await Promise.all([
      ethCallAddressProbe(chain, address, '0x8da5cb5b').then((v) => v || ethCallAddressProbe(chain, address, '0x893d20e8')),
      ethCallBoolProbe(chain, address, '0x5c975abb'),
      ethGetStorageAt(chain, address, EIP1967_IMPLEMENTATION_SLOT).catch(() => null),
      ethGetStorageAt(chain, address, EIP1967_ADMIN_SLOT).catch(() => null),
      fetchRecentGovernanceEvents(chain, address).catch(() => null)
    ]);

    const implementation = parseAddressFromHexResult(implementationSlotRaw) || normalizeEvmAddress(sourceCode && sourceCode.implementation);
    const proxyAdmin = parseAddressFromHexResult(adminSlotRaw);

    const abiSelectors = mergeControlIndicators(sourceCode);
    const selectors = {
      owner: !!(hasSelectorInCode(code, '8da5cb5b') || hasSelectorInCode(code, '893d20e8') || abiSelectors.owner),
      pause: !!(hasSelectorInCode(code, '8456cb59') || abiSelectors.pause),
      unpause: !!(hasSelectorInCode(code, '3f4ba83a') || abiSelectors.unpause),
      mint: !!(hasSelectorInCode(code, '40c10f19') || abiSelectors.mint),
      blacklist: !!(hasSelectorInCode(code, 'f9f92be4') || hasSelectorInCode(code, '4f2be91f') || hasSelectorInCode(code, '4a0bfec1') || abiSelectors.blacklist),
      setFee: !!(hasSelectorInCode(code, '69fe0e2d') || hasSelectorInCode(code, 'f2fde38b') || abiSelectors.setFee),
      burn: !!abiSelectors.burn,
      upgrade: !!abiSelectors.upgrade,
      tradingControl: !!abiSelectors.tradingControl,
      walletLimits: !!abiSelectors.walletLimits,
      whitelist: !!abiSelectors.whitelist,
      rescue: !!abiSelectors.rescue,
      routerControl: !!abiSelectors.routerControl,
      cooldown: !!abiSelectors.cooldown,
      feeConfig: !!abiSelectors.feeConfig,
      approvalControl: !!abiSelectors.approvalControl
    };

    let implementationControl = null;
    const followImplementation = implementation || (sourceCode && sourceCode.implementation) || null;
    if (
      depth < maxDepth &&
      followImplementation &&
      /^0x[a-fA-F0-9]{40}$/.test(String(followImplementation)) &&
      String(followImplementation).toLowerCase() !== String(address).toLowerCase() &&
      !seen.has(String(followImplementation).toLowerCase())
    ) {
      try {
        implementationControl = await getContractControl(chain, followImplementation, {
          depth: depth + 1,
          maxDepth,
          seen
        });
      } catch (_) {
        implementationControl = null;
      }
    }

    return {
      codeSize: String(code).length,
      ownerAddress: ownerAddress || null,
      paused: typeof paused === 'boolean' ? paused : null,
      proxy: {
        implementation: implementation || null,
        admin: proxyAdmin || null,
        detected: !!(implementation || proxyAdmin || (sourceCode && sourceCode.proxyDetected))
      },
      selectors,
      sourceCode: sourceCode || null,
      recentEvents: recentEvents || null,
      implementationControl: implementationControl || null
    };
  } catch (_) {
    return null;
  }
}


// ---------------- TOKEN META VIA RPC ----------------

async function getTokenMetaViaRpc(chain, address) {
  try {
    const [nameHex, symbolHex, decimalsHex, totalSupplyHex] = await Promise.all([
      ethCallSimulate(chain, address, '0x06fdde03').catch(() => null), // name()
      ethCallSimulate(chain, address, '0x95d89b41').catch(() => null), // symbol()
      ethCallSimulate(chain, address, '0x313ce567').catch(() => null), // decimals()
      ethCallSimulate(chain, address, '0x18160ddd').catch(() => null)  // totalSupply()
    ]);

    const rawName = parseStringFromHex(nameHex);
    const rawSymbol = parseStringFromHex(symbolHex);

    // Если оба не прочитались — считаем, что это не токен (или мета недоступна)
    if (!rawName && !rawSymbol) {
      return null;
    }

    const name = rawName || 'Unknown';
    const symbol = rawSymbol || 'TKN';

    let decimals = 18;
    if (decimalsHex && decimalsHex !== '0x') {
      try {
        const clean = decimalsHex.startsWith('0x') ? decimalsHex.slice(2) : decimalsHex;
        if (clean) {
          const decVal = parseInt(clean, 16);
          if (Number.isFinite(decVal) && decVal >= 0 && decVal <= 36) {
            decimals = decVal;
          }
        }
      } catch (e) {
        // оставляем default = 18
      }
    }

    let totalSupply = null;
    let totalSupplyFormatted = null;
    if (totalSupplyHex && totalSupplyHex !== '0x') {
      try {
        const clean = totalSupplyHex.startsWith('0x') ? totalSupplyHex.slice(2) : totalSupplyHex;
        if (clean) {
          const value = BigInt('0x' + clean);
          totalSupply = value.toString();

          if (decimals >= 0 && decimals <= 36) {
            const base = 10n ** BigInt(decimals);
            const whole = value / base;
            const fraction = value % base;
            let fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
            if (fractionStr) {
              fractionStr = fractionStr.slice(0, 6);
              totalSupplyFormatted = whole.toString() + '.' + fractionStr;
            } else {
              totalSupplyFormatted = whole.toString();
            }
          }
        }
      } catch (e) {
        // если что-то пошло не так — оставим totalSupply/null
      }
    }

    return { name, symbol, decimals, totalSupply, totalSupplyFormatted };
  } catch (e) {
    return null;
  }
}

// ---------------- NETWORK SCAN (используется walletService) ----------------

async function scanNetwork(chain, address) {
  const result = {
    chain,
    balanceWei: '0',
    txCount: 0,
    scamSignals: [],
    error: null
  };

  try {
    // История через Etherscan — только для Ethereum
    if (chain === 'ethereum') {
      const txs = await getEtherscanTransactions(address);
      if (txs !== null) {
        const analysis = analyzeTxHistory(txs, address);
        result.txCount = analysis.txCount;
        result.scamSignals = analysis.signals;
      }
    }

    // Баланс через RPC
    const balanceHex = await callRpcWithFallback(chain, 'eth_getBalance', [address, 'latest']);
    if (balanceHex) {
      result.balanceWei = BigInt(balanceHex).toString();
    }

    // Если по истории txCount == 0 — пробуем RPC tx count
    if (result.txCount === 0) {
      const txCountHex = await callRpcWithFallback(chain, 'eth_getTransactionCount', [
        address,
        'latest'
      ]);
      if (txCountHex) {
        result.txCount = parseInt(txCountHex, 16);
      }
    }

    return result;
  } catch (e) {
    return {
      chain,
      balanceWei: '0',
      txCount: 0,
      scamSignals: [],
      error: e.message || 'RPC_ERROR'
    };
  }
}

module.exports = {
  scanNetwork,
  checkHoneypot,
  simulateTradingPaths,
  getTokenMetaViaRpc,
  getContractControl,
  ethCallSimulate,
  fetchExplorerSourceCode,
  fetchDexLiquiditySummary,
  fetchExplorerHolderSummary
};
