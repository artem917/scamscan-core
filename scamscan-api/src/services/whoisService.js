const axios = require('axios');
const { execFile } = require('child_process');
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");


// --- Helpers ------------------------------------------------------------

// Универсальная конвертация даты/таймстемпа в ISO-строку
function toIsoDate(value) {
  if (!value) return null;

  // Массив → ищем в нём что-то осмысленное
  if (Array.isArray(value)) {
    const ts = value.find(
      (v) => typeof v === 'number' || /^\d+$/.test(String(v))
    );
    if (ts !== undefined) return toIsoDate(ts);
    if (value.length > 0) return toIsoDate(value[0]);
    return null;
  }

  // Число → timestamp
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Строка
  if (typeof value === 'string') {
    const trimmed = value.trim();

    // Числовая строка → timestamp
    if (/^\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      const ms = num > 1e12 ? num : num * 1000;
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }

    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  return null;
}

// Посчитать возраст домена в днях из ISO-строки
function calcAgeDays(createdAtIso) {
  if (!createdAtIso) return null;
  const d = new Date(createdAtIso);
  if (isNaN(d.getTime())) return null;

  const diffMs = Date.now() - d.getTime();
  if (diffMs <= 0) return null;

  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// Нормализуем домен из чего угодно (URL, hostname, etc.)
function normalizeDomain(input) {
  if (!input) return null;
  let value = String(input).trim();

  // Убираем протокол
  value = value.replace(/^https?:\/\//i, '');

  // Отрезаем путь / query / hash
  value = value.split('/')[0].split('?')[0].split('#')[0];

  if (!value) return null;

  return value.toLowerCase();
}


// SCAMSCAN_RDAP_BOOTSTRAP_CLEAN_V1
const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const RDAP_BOOTSTRAP_CACHE_FILE = path.join(__dirname, '../../data/rdap_bootstrap_dns.json');
const RDAP_BOOTSTRAP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const WHOIS_CACHE_DIR = path.join(__dirname, '../../data/whois_cache');
const WHOIS_CACHE_OK_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const WHOIS_CACHE_FAIL_TTL_MS = 10 * 60 * 1000; // 10 minutes

let _rdapBootstrap = null;
let _rdapBootstrapLoadedAt = 0;
const _whoisMemoryCache = new Map();

function _uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of (arr || [])) {
    const v = String(x || '').trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function _getTld(domain) {
  const d = String(domain || '').toLowerCase().replace(/\.+$/, '').trim();
  const parts = d.split('.').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function _buildRdapUrl(base, domain) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return null;
  if (/\/domain$/i.test(b)) return `${b}/${domain}`;
  return `${b}/domain/${domain}`;
}

function _cacheFresh(st) {
  try {
    const age = Date.now() - st.mtimeMs;
    return age >= 0 && age < RDAP_BOOTSTRAP_TTL_MS;
  } catch (_) {
    return false;
  }
}

function _whoisCacheKey(domain) {
  return crypto.createHash("sha256").update(String(domain || "").trim().toLowerCase()).digest("hex");
}

function _whoisCacheTtlMs(row) {
  const hasSignal = !!(
    row &&
    (
      row.createdAt ||
      row.ageDays !== null ||
      row.registrar ||
      (row.coverage && row.coverage.ageKnown)
    )
  );
  return hasSignal ? WHOIS_CACHE_OK_TTL_MS : WHOIS_CACHE_FAIL_TTL_MS;
}

function _readWhoisMemory(domain) {
  const key = _whoisCacheKey(domain);
  const cached = _whoisMemoryCache.get(key);
  if (!cached || !cached.data) return null;
  const age = Date.now() - Number(cached.ts || 0);
  if (age < 0 || age > _whoisCacheTtlMs(cached.data)) {
    _whoisMemoryCache.delete(key);
    return null;
  }
  return Object.assign({}, cached.data, { cache: { layer: "memory", hit: true } });
}

function _writeWhoisMemory(domain, data) {
  try {
    _whoisMemoryCache.set(_whoisCacheKey(domain), { ts: Date.now(), data: Object.assign({}, data || {}) });
  } catch (_) {}
}

function _whoisCacheFile(domain) {
  return path.join(WHOIS_CACHE_DIR, _whoisCacheKey(domain) + ".json");
}

function _readWhoisDisk(domain) {
  try {
    const file = _whoisCacheFile(domain);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || !raw.data) return null;
    const age = Date.now() - Number(raw.ts || 0);
    if (age < 0 || age > _whoisCacheTtlMs(raw.data)) return null;
    return Object.assign({}, raw.data, { cache: { layer: "disk", hit: true } });
  } catch (_) {
    return null;
  }
}

function _writeWhoisDisk(domain, data) {
  try {
    fs.mkdirSync(WHOIS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(_whoisCacheFile(domain), JSON.stringify({ ts: Date.now(), data: Object.assign({}, data || {}) }), "utf8");
  } catch (_) {}
}

async function _readBootstrapDisk() {
  try {
    if (!fs.existsSync(RDAP_BOOTSTRAP_CACHE_FILE)) return null;
    const st = fs.statSync(RDAP_BOOTSTRAP_CACHE_FILE);
    if (!_cacheFresh(st)) return null;
    const raw = fs.readFileSync(RDAP_BOOTSTRAP_CACHE_FILE, 'utf-8');
    const json = JSON.parse(raw);
    return (json && Array.isArray(json.services)) ? json : null;
  } catch (_) {
    return null;
  }
}

async function _writeBootstrapDisk(json) {
  try {
    fs.mkdirSync(path.dirname(RDAP_BOOTSTRAP_CACHE_FILE), { recursive: true });
    fs.writeFileSync(RDAP_BOOTSTRAP_CACHE_FILE, JSON.stringify(json), 'utf-8');
  } catch (_) {}
}

async function _getBootstrap() {
  const now = Date.now();
  if (_rdapBootstrap && (now - _rdapBootstrapLoadedAt) < RDAP_BOOTSTRAP_TTL_MS) return _rdapBootstrap;

  const disk = await _readBootstrapDisk();
  if (disk) {
    _rdapBootstrap = disk;
    _rdapBootstrapLoadedAt = now;
    return _rdapBootstrap;
  }

  try {
    const resp = await axios.get(RDAP_BOOTSTRAP_URL, {
      timeout: 8000,
      headers: { Accept: 'application/json' },
    });
    const json = resp && resp.data ? resp.data : null;
    if (json && Array.isArray(json.services)) {
      _rdapBootstrap = json;
      _rdapBootstrapLoadedAt = now;
      await _writeBootstrapDisk(json);
      return _rdapBootstrap;
    }
  } catch (_) {}

  return null;
}

async function _rdapBasesForDomain(domain) {
  const tld = _getTld(domain);
  const boot = await _getBootstrap();
  if (!tld || !boot || !Array.isArray(boot.services)) return [];
  for (const svc of boot.services) {
    if (!Array.isArray(svc) || svc.length < 2) continue;
    const tlds = svc[0] || [];
    const bases = svc[1] || [];
    if (Array.isArray(tlds) && tlds.map(x => String(x).toLowerCase()).includes(tld)) {
      return Array.isArray(bases) ? bases.slice() : [];
    }
  }
  return [];
}
// /SCAMSCAN_RDAP_BOOTSTRAP_CLEAN_V1




// --- WHOIS через API Ninjas --------------------------------------------

async function fetchFromApiNinjas(domain) {
  const apiKey = process.env.API_NINJAS_WHOIS_KEY;

  if (!apiKey) {
    console.warn('[Whois] API_NINJAS_WHOIS_KEY is not configured, skipping ApiNinjas');
    return {
      ageDays: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      registrar: null,
      status: null,
      raw: null,
      error: 'missing_api_key',
      source: 'api_ninjas',
    };
  }

  if (!domain) {
    console.warn('[Whois] Invalid domain passed to ApiNinjas:', domain);
    return {
      ageDays: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      registrar: null,
      status: null,
      raw: null,
      error: 'invalid_domain',
      source: 'api_ninjas',
    };
  }

  try {
    const resp = await axios.get('https://api.api-ninjas.com/v1/whois', {
      params: { domain },
      headers: { 'X-Api-Key': apiKey },
      timeout: 7000,
    });

    const data = resp && resp.data ? resp.data : {};

    const createdAt = toIsoDate(data.creation_date || data.created || null);
    const updatedAt = toIsoDate(
      data.updated_date || data.updated || data.changed || null
    );
    const expiresAt = toIsoDate(
      data.expiration_date || data.expires || null
    );

    const ageDays = calcAgeDays(createdAt);

    return {
      ageDays,
      createdAt,
      updatedAt,
      expiresAt,
      registrar: data.registrar_name || data.registrar || null,
      status: data.status || null,
      raw: data,
      error: null,
      source: 'api_ninjas',
    };
  } catch (error) {
    const status =
      error.response && error.response.status ? error.response.status : null;
    const bodyError =
      (error.response &&
        error.response.data &&
        (error.response.data.error || error.response.data.message)) ||
      null;

    const msg = status
      ? `status ${status}` + (bodyError ? `: ${bodyError}` : '')
      : error.message;

    console.error(
      '[Whois] ApiNinjas WHOIS HTTP error for %s: %s',
      domain,
      msg
    );

    return {
      ageDays: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      registrar: null,
      status: null,
      raw: error.response ? error.response.data : null,
      error: msg || 'api_ninjas_error',
      source: 'api_ninjas',
    };
  }
}

// --- WHOIS через RDAP (rdap.org) ---------------------------------------

// SCAMSCAN_RDAP_PARSE_V1
function parseRdapData(data) {
  try {
    if (!data || typeof data !== "object") {
      return { error: "rdap_empty", rawData: null, warnings: ["RDAP returned empty/invalid object"] };
    }

    const events = Array.isArray(data.events) ? data.events : [];

    const pickEvent = (needAction) => {
      const ev = events.find(e => e && String(e.eventAction || "").toLowerCase().includes(needAction));
      if (ev && ev.eventDate) return ev.eventDate;
      return null;
    };

    const createdAt = toIsoDate(
      pickEvent("registration") || pickEvent("registered") || pickEvent("creation") || data.registrationDate || data.created || data.creationDate || null
    );
    const updatedAt = toIsoDate(
      pickEvent("last changed") || pickEvent("changed") || pickEvent("update") || data.updated || data.lastUpdateOfRdapDb || null
    );
    const expiresAt = toIsoDate(
      pickEvent("expiration") || pickEvent("expiry") || pickEvent("expire") || data.expire || data.expirationDate || null
    );

    const registrar =
      (data.registrar && (data.registrar.name || data.registrar)) ||
      (data.entities && Array.isArray(data.entities) && (
        (data.entities.find(x => Array.isArray(x.roles) && x.roles.includes("registrar")) || {}).vcardArray
      )) ||
      null;

    let registrarName = null;
    if (typeof registrar === "string") registrarName = registrar;
    if (Array.isArray(registrar) && registrar.length >= 2 && Array.isArray(registrar[1])) {
      // vcardArray format
      try {
        const rows = registrar[1];
        const fn = rows.find(r => Array.isArray(r) && r[0] === "fn");
        if (fn && Array.isArray(fn) && fn[3]) registrarName = String(fn[3]);
      } catch (_) {}
    }

    const status = Array.isArray(data.status) ? data.status.join(", ") : (data.status ? String(data.status) : null);

    return {
      ageDays: calcAgeDays(createdAt),
      createdAt,
      updatedAt,
      expiresAt,
      registrar: registrarName || null,
      status,
      rawData: data,
      error: null,
      source: "rdap"
    };
  } catch (e) {
    return { error: "rdap_parse_error", rawData: data || null, warnings: ["RDAP parse failed: " + String(e && e.message || e)] };
  }
}

async function fetchFromRdap(domain) {
  const bases = await _rdapBasesForDomain(domain);
  const candidates = _uniq([ ...(bases || []), 'https://rdap.iana.org', 'https://rdap.org', 'https://rdap.org/domain' ]);

  let lastErr = null;

  for (const base of candidates) {
    const url = _buildRdapUrl(base, domain);
    if (!url) continue;

    try {
      const resp = await axios.get(url, {
        timeout: 10000,
        headers: {
          Accept: 'application/rdap+json, application/json;q=0.9, */*;q=0.8',
          'User-Agent': 'ScamScan-RDAP/1.0 (+https://scamscan.online)',
        },
      });

      const data = resp && resp.data ? resp.data : {};
      const out = parseRdapData(data);
      if (out && out.rawData) {
        out.rawData.rdapBase = base;
      out.rawData.rdapUrl = url;
      out.rdapBase = base;
      out.rdapUrl = url;
      }
      return out;
    } catch (e) {
      const st = e && e.response && e.response.status ? e.response.status : null;
      lastErr = st ? `HTTP_${st}` : (e && e.message ? e.message : 'rdap_error');
      continue;
    }
  }

  return { error: lastErr || 'rdap_failed', rawData: null, warnings: ['RDAP lookup failed (TLD-aware).'] };
}

// --- Высокоуровневая обёртка -------------------------------------------

// SCAMSCAN_WHOIS_CLI_FALLBACK_V1
function _pickDate(line) {
  try {
    const m = String(line || "").match(/(\d{4}-\d{2}-\d{2}|\d{2}-[A-Za-z]{3}-\d{4}|\d{4}\.\d{2}\.\d{2})/);
    return m ? String(m[1]) : null;
  } catch (e) { return null; }
}

function _toIsoLoose(v) {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + "T00:00:00.000Z";
  if (/^\d{4}\.\d{2}\.\d{2}$/.test(v)) return v.replace(/\./g,"-") + "T00:00:00.000Z";
  if (/^\d{2}-[A-Za-z]{3}-\d{4}$/.test(v)) {
    const mm = {"jan":"01","feb":"02","mar":"03","apr":"04","may":"05","jun":"06","jul":"07","aug":"08","sep":"09","oct":"10","nov":"11","dec":"12"};
    const dd=v.slice(0,2); const mon=mm[v.slice(3,6).toLowerCase()]||"01"; const yy=v.slice(7,11);
    return `${yy}-${mon}-${dd}T00:00:00.000Z`;
  }
  return null;
}

function _calcAgeDays(iso) {
  try {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!t) return null;
    const days = Math.floor((Date.now() - t) / 86400000);
    return (days >= 0 && days < 40000) ? days : null;
  } catch (e) { return null; }
}

async function fetchFromWhoisCli(domain) {
  return await new Promise((resolve) => {
    execFile("whois", [domain], { timeout: 9000 }, (err, stdout, stderr) => {
      const out = String(stdout || "") + "\n" + String(stderr || "");
      if (err && !out.trim()) {
        return resolve({ error: "WHOIS_CLI_FAILED", ageDays: null, createdAt: null, registrar: null, source: "whois-cli" });
      }

      const lines = out.split(/\r?\n/);

      let createdRaw = null;
      let registrar = null;

      for (const ln of lines) {
        const l = String(ln || "").trim();
        const low = l.toLowerCase();

        if (!createdRaw && (low.startsWith("creation date") || low.startsWith("created") || low.startsWith("registered on") || low.startsWith("registration time") || low.startsWith("domain create date"))) {
          createdRaw = _pickDate(l);
        }

        if (!registrar && low.startsWith("registrar:")) {
          registrar = l.split(":").slice(1).join(":").trim() || null
        }
      }

      // нормальный парс Registrar:
      if (!registrar) {
        for (const ln of lines) {
          const l = String(ln || "").trim();
          const low = l.toLowerCase();
          if (low.startsWith("registrar:")) {
            registrar = l.split(":").slice(1).join(":").trim() || null;
            break;
          }
        }
      }

      const createdAt = _toIsoLoose(createdRaw);
      const ageDays = _calcAgeDays(createdAt);

      resolve({
        error: null,
        source: "whois-cli",
        registrar: registrar || null,
        createdAt: createdAt || null,
        ageDays: ageDays,
        rdapUrl: 'https://rdap.org/domain/' + domain,
        rawData: { whoisText: out }
      });
    });
  });
}

async function fetchDomainWhois(inputDomain) {
  const domain = normalizeDomain(inputDomain);
  const _ageKnown = (row) => !!(row && (row.createdAt || row.ageDays !== null));
  if (!domain) {
    return {
      ageDays: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      registrar: null,
      status: null,
      rawData: null,
      error: "invalid_domain",
      source: "aggregated",
      coverage: {
        sourceOfTruth: "aggregated",
        ageKnown: false,
        registrarKnown: false,
        fallbackChain: []
      }
    };
  }

  const memCached = _readWhoisMemory(domain);
  if (memCached) return memCached;
  const diskCached = _readWhoisDisk(domain);
  if (diskCached) {
    _writeWhoisMemory(domain, diskCached);
    return diskCached;
  }

  let rdapResult = null;
  let apiNinjasResult = null;
  let whoisCliResult = null;
  const fallbackChain = [];

  // 1) Сначала пробуем RDAP как основной бесплатный источник
  fallbackChain.push('rdap');
  rdapResult = await fetchFromRdap(domain);
  if (rdapResult && !rdapResult.error && rdapResult.ageDays !== null) {
    const out = Object.assign({}, rdapResult, {
      coverage: {
        sourceOfTruth: 'rdap',
        ageKnown: _ageKnown(rdapResult),
        registrarKnown: !!rdapResult.registrar,
        fallbackChain
      }
    });
    _writeWhoisMemory(domain, out);
    _writeWhoisDisk(domain, out);
    return out;
  }

  // 2) Если RDAP не дал возраст — пробуем ApiNinjas (если есть ключ)
  if (process.env.API_NINJAS_WHOIS_KEY) {
    fallbackChain.push('api_ninjas');
    apiNinjasResult = await fetchFromApiNinjas(domain);
    if (apiNinjasResult && !apiNinjasResult.error && apiNinjasResult.ageDays !== null) {
      const out = Object.assign({}, apiNinjasResult, {
        coverage: {
          sourceOfTruth: 'api_ninjas',
          ageKnown: _ageKnown(apiNinjasResult),
          registrarKnown: !!apiNinjasResult.registrar,
          fallbackChain
        }
      });
      _writeWhoisMemory(domain, out);
      _writeWhoisDisk(domain, out);
      return out;
    }
  }

  // SCAMSCAN_WHOIS_CLI_FALLBACK_V1 (step)
  fallbackChain.push('whois_cli');
  whoisCliResult = await fetchFromWhoisCli(domain);
  if (whoisCliResult && !whoisCliResult.error && whoisCliResult.ageDays !== null) {
    const out = Object.assign({}, whoisCliResult, {
      coverage: {
        sourceOfTruth: 'whois-cli',
        ageKnown: _ageKnown(whoisCliResult),
        registrarKnown: !!whoisCliResult.registrar,
        fallbackChain
      }
    });
    _writeWhoisMemory(domain, out);
    _writeWhoisDisk(domain, out);
    return out;
  }


  // 3) Всё упало — отдаём максимум из того, что удалось вытащить
  const bestSource =
    (rdapResult && !rdapResult.error && (rdapResult.ageDays !== null || rdapResult.createdAt || rdapResult.registrar)) ? 'rdap' :
    (apiNinjasResult && !apiNinjasResult.error && (apiNinjasResult.ageDays !== null || apiNinjasResult.createdAt || apiNinjasResult.registrar)) ? 'api_ninjas' :
    (whoisCliResult && !whoisCliResult.error && (whoisCliResult.ageDays !== null || whoisCliResult.createdAt || whoisCliResult.registrar)) ? 'whois-cli' :
    'aggregated';

  const out = {
    ageDays:
      (rdapResult && rdapResult.ageDays) ||
      (apiNinjasResult && apiNinjasResult.ageDays) ||
      (whoisCliResult && whoisCliResult.ageDays) ||
      null,
    createdAt:
      (rdapResult && rdapResult.createdAt) ||
      (apiNinjasResult && apiNinjasResult.createdAt) ||
      (whoisCliResult && whoisCliResult.createdAt) ||
      null,
    updatedAt:
      (rdapResult && rdapResult.updatedAt) ||
      (apiNinjasResult && apiNinjasResult.updatedAt) ||
      (whoisCliResult && whoisCliResult.updatedAt) ||
      null,
    expiresAt:
      (rdapResult && rdapResult.expiresAt) ||
      (apiNinjasResult && apiNinjasResult.expiresAt) ||
      (whoisCliResult && whoisCliResult.expiresAt) ||
      null,
    registrar:
      (rdapResult && rdapResult.registrar) ||
      (apiNinjasResult && apiNinjasResult.registrar) ||
      (whoisCliResult && whoisCliResult.registrar) ||
      null,
    status:
      (rdapResult && rdapResult.status) ||
      (apiNinjasResult && apiNinjasResult.status) ||
      (whoisCliResult && whoisCliResult.status) ||
      null,
    rawData: {
      rdap: rdapResult && (rdapResult.rawData || rdapResult.raw),
      apiNinjas: apiNinjasResult && (apiNinjasResult.rawData || apiNinjasResult.raw),
      whoisCli: whoisCliResult && (whoisCliResult.rawData || whoisCliResult.raw),
    },
    error:
      (rdapResult && rdapResult.error) ||
      (apiNinjasResult && apiNinjasResult.error) ||
      (whoisCliResult && whoisCliResult.error) ||
      'whois_all_failed',
    source: bestSource,
    coverage: {
      sourceOfTruth: bestSource,
      ageKnown: _ageKnown(rdapResult) || _ageKnown(apiNinjasResult) || _ageKnown(whoisCliResult),
      registrarKnown: !!(
        (rdapResult && rdapResult.registrar) ||
        (apiNinjasResult && apiNinjasResult.registrar) ||
        (whoisCliResult && whoisCliResult.registrar)
      ),
      fallbackChain
    }
  };
  _writeWhoisMemory(domain, out);
  _writeWhoisDisk(domain, out);
  return out;
}


async function analyzeWhois(domain) {
  const data = await fetchDomainWhois(domain);
  let risk = 0;
  const warnings = [];

  if (data.error) {
    const errStr = String(data.error || '').toLowerCase();
    const isQuotaError =
      errStr.includes('quota exceeded') ||
      errStr.includes('monthly quota') ||
      errStr.includes('limit exceeded');

    // Ошибки поставщика типа "quota exceeded" пользователю не показываем,
    // они никак не описывают надёжность домена.
    if (!isQuotaError) {
      if (errStr.includes("status 404") || errStr.includes("not found")) {
      warnings.push("WHOIS registry did not return data for this domain (HTTP 404 from WHOIS/RDAP). The website itself can still be reachable; this only affects registration data, not site availability.");
    } else {
      warnings.push("WHOIS lookup had issues (source=" + data.source + "): " + data.error);
    }
    }
  }

  if (data.ageDays !== null) {
    if (data.ageDays < 7) {
      risk += 60;
      warnings.push(`VERY NEW DOMAIN (${data.ageDays} days old). High scam risk.`);
    } else if (data.ageDays < 30) {
      risk += 25;
      warnings.push(`Young domain (${data.ageDays} days old).`);
    } else if (data.ageDays < 90) {
      risk += 10;
      warnings.push(`Relatively new domain (${data.ageDays} days old).`);
    }
  } else {
    warnings.push('Domain age unknown (WHOIS/RDAP did not return creation date).');
  }

  return {
    riskScore: risk,
    warnings,
    rawData: data,
  };
}

module.exports = {
  fetchDomainWhois,
  analyzeWhois,
};
