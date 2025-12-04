const axios = require('axios');

// Универсальная конвертация даты из WHOIS в ISO-строку
function toIsoDate(value) {
  if (!value) return null;

  // Если массив — ищем внутри нормальное значение
  if (Array.isArray(value)) {
    // 1) если в массиве есть число (timestamp) — используем его
    const ts = value.find(v => typeof v === 'number' || (/^\d+$/.test(String(v))));
    if (ts !== undefined) return toIsoDate(ts);

    // 2) иначе берём первый непустой элемент как строку
    if (value.length > 0) return toIsoDate(value[0]);

    return null;
  }

  // Value — число → timestamp
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Строка — может быть timestamp
  if (typeof value === 'string') {
    const trimmed = value.trim();

    // Числовая строка → timestamp
    if (/^\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      const ms = num > 1e12 ? num : num * 1000;
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }

    // Обычная строковая дата
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  return null;
}

// --- Fetch Whois Data ---
async function fetchDomainWhois(domain) {
  const apiKey = process.env.API_NINJAS_WHOIS_KEY;
  if (!apiKey || !domain) {
    return {
      ageDays: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      registrar: null,
      status: null,
      raw: null,
      error: !apiKey ? 'missing_api_key' : 'invalid_domain'
    };
  }

  try {
    const resp = await axios.get('https://api.api-ninjas.com/v1/whois', {
      params: { domain },
      headers: { 'X-Api-Key': apiKey },
      timeout: 7000
    });

    const data = resp && resp.data ? resp.data : {};

    const createdAt = toIsoDate(data.creation_date || data.created || null);
    const updatedAt = toIsoDate(data.updated_date || data.updated || data.changed || null);
    const expiresAt = toIsoDate(data.expiration_date || data.expires || null);

    let ageDays = null;
    if (createdAt) {
      const d = new Date(createdAt);
      if (!isNaN(d.getTime())) {
        const diffMs = Date.now() - d.getTime();
        if (diffMs > 0) {
          ageDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        }
      }
    }

    return {
      ageDays,
      createdAt,
      updatedAt,
      expiresAt,
      registrar: data.registrar_name || data.registrar || null,
      status: data.status || null,
      raw: data,
      error: null
    };
  } catch (error) {
    return {
      ageDays: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      registrar: null,
      status: null,
      raw: null,
      error: error.message
    };
  }
}

// --- Analyze Whois Logic ---
async function analyzeWhois(domain) {
  const data = await fetchDomainWhois(domain);
  let risk = 0;
  const warnings = [];

  if (data.error) {
    return { riskScore: 0, warnings: [], rawData: null };
  }

  if (data.ageDays !== null) {
    if (data.ageDays < 7) {
      risk += 60;
      warnings.push(`VERY NEW DOMAIN (${data.ageDays} days old). High scam risk.`);
    } else if (data.ageDays < 30) {
      risk += 25;
      warnings.push(`Young domain (${data.ageDays} days old).`);
    }
  } else {
    warnings.push('Domain age unknown (Hidden Whois?)');
  }

  return {
    riskScore: risk,
    warnings,
    rawData: data
  };
}

module.exports = { fetchDomainWhois, analyzeWhois };
