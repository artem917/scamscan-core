const axios = require('axios');
const config = require('../config');

async function checkValue(type, value) {
  try {
    const res = await axios.get(config.apiBaseUrl + '/check', {
      params: { type: type, value: value },
      timeout: 20000
    });
    return { ok: true, data: res.data };
  } catch (err) {
    console.error('API error:', err.message);
    return { ok: false, error: err.message || 'Request failed' };
  }
}

module.exports = {
  checkValue: checkValue
};
