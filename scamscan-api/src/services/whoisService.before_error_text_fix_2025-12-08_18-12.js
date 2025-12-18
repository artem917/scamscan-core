const axios = require('axios');

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

async function fetchFromRdap(domain) {
  if (!domain) {
    console.warn('[Whois] Invalid domain passed to RDAP:', domain);
    return {
      ageDays: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      registrar: null,
      status: null,
      raw: null,
      error: 'invalid_domain',
      source: 'rdap',
    };
  }

  try {
    const resp = await axios.get(
      `https://rdap.org/domain/${encodeURIComponent(domain)}`,
      {
        timeout: 10000,
        headers: {
          Accept:
            'application/rdap+json, application/json;q=0.9, */*;q=0.8',
        },
      }
    );

    const data = resp && resp.data ? resp.data : {};

    // RDAP events: ищем registration / expiration / last changed
    const events = Array.isArray(data.events) ? data.events : [];
    const findEvent = (...names) =>
      events.find((e) => {
        const action = String(e.eventAction || e.action || '').toLowerCase();
        return names.some((name) => action.includes(name));
      });

    const createdAt = toIsoDate(
      (findEvent('registration', 'registered', 'creation', 'created') || {}).eventDate
    );
    const updatedAt = toIsoDate(
      (findEvent('last changed', 'last change', 'last update', 'update', 'updated') || {})
        .eventDate
    );
    const expiresAt = toIsoDate(
      (findEvent('expiration', 'expire', 'expiry', 'expires') || {})
        .eventDate
    );

    const ageDays = calcAgeDays(createdAt);

    // RDAP entities → registrar name
    let registrar = null;
    const entities = Array.isArray(data.entities) ? data.entities : [];
    for (const ent of entities) {
      const roles = Array.isArray(ent && ent.roles) ? ent.roles : [];
      if (
        roles
          .map((r) => String(r).toLowerCase())
          .includes('registrar')
      ) {
        const vcardArray =
          Array.isArray(ent.vcardArray) && ent.vcardArray.length > 1
            ? ent.vcardArray[1]
            : null;
        if (Array.isArray(vcardArray)) {
          const fnField = vcardArray.find(
            (v) => Array.isArray(v) && v[0] === 'fn'
          );
          if (fnField && fnField.length >= 4 && fnField[3]) {
            registrar = fnField[3];
            break;
          }
        }
      }
    }

    return {
      ageDays,
      createdAt,
      updatedAt,
      expiresAt,
      registrar,
      status: data.status || null,
      raw: data,
      error: null,
      source: 'rdap',
    };
  } catch (error) {
    const status =
      error.response && error.response.status ? error.response.status : null;

    console.error(
      '[Whois] RDAP error for %s: %s %s',
      domain,
      status ? `status ${status}` : 'no-status',
      error.message
    );

    return {
      ageDays: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      registrar: null,
      status: null,
      raw: error.response ? error.response.data : null,
      error:
        (status ? `status ${status}` : null) ||
        `rdap_error: ${error.message}`,
      source: 'rdap',
    };
  }
}

// --- Высокоуровневая обёртка -------------------------------------------

async function fetchDomainWhois(inputDomain) {
  const domain = normalizeDomain(inputDomain);

  let rdapResult = null;
  let apiNinjasResult = null;

  // 1) Сначала пробуем RDAP как основной бесплатный источник
  rdapResult = await fetchFromRdap(domain);
  if (rdapResult && !rdapResult.error && rdapResult.ageDays !== null) {
    return rdapResult;
  }

  // 2) Если RDAP не дал возраст — пробуем ApiNinjas (если есть ключ)
  if (process.env.API_NINJAS_WHOIS_KEY) {
    apiNinjasResult = await fetchFromApiNinjas(domain);
    if (apiNinjasResult && !apiNinjasResult.error && apiNinjasResult.ageDays !== null) {
      return apiNinjasResult;
    }
  }

  // 3) Всё упало — отдаём максимум из того, что удалось вытащить
  return {
    ageDays:
      (rdapResult && rdapResult.ageDays) ||
      (apiNinjasResult && apiNinjasResult.ageDays) ||
      null,
    createdAt:
      (rdapResult && rdapResult.createdAt) ||
      (apiNinjasResult && apiNinjasResult.createdAt) ||
      null,
    updatedAt:
      (rdapResult && rdapResult.updatedAt) ||
      (apiNinjasResult && apiNinjasResult.updatedAt) ||
      null,
    expiresAt:
      (rdapResult && rdapResult.expiresAt) ||
      (apiNinjasResult && apiNinjasResult.expiresAt) ||
      null,
    registrar:
      (rdapResult && rdapResult.registrar) ||
      (apiNinjasResult && apiNinjasResult.registrar) ||
      null,
    status:
      (rdapResult && rdapResult.status) ||
      (apiNinjasResult && apiNinjasResult.status) ||
      null,
    raw: {
      rdap: rdapResult && rdapResult.raw,
      apiNinjas: apiNinjasResult && apiNinjasResult.raw,
    },
    error:
      (rdapResult && rdapResult.error) ||
      (apiNinjasResult && apiNinjasResult.error) ||
      'whois_all_failed',
    source: 'aggregated',
  };
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
      warnings.push(`WHOIS lookup had issues (source=${data.source}): ${data.error}`);
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
