const fs = require('fs');
const path = require('path');
require('dotenv').config();

const baseDir = __dirname;

const config = {
  botToken: process.env.BOT_TOKEN,
  apiBaseUrl: process.env.SCAMSCAN_API_BASE || 'https://scamscan.online/api',
  maxFreeChecksPerDay: parseInt(process.env.MAX_FREE_CHECKS_PER_DAY || '30', 10),
  logsDir: path.join(baseDir, 'logs'),
  dataDir: path.join(baseDir, 'data')
};

config.feedbackLogPath = path.join(config.logsDir, 'feedback.log');
config.usageFilePath = path.join(config.dataDir, 'usage.json');
config.proUsersFilePath = path.join(config.dataDir, 'pro_users.json');

// ensure dirs exist
[config.logsDir, config.dataDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ensure data files exist
if (!fs.existsSync(config.usageFilePath)) {
  fs.writeFileSync(config.usageFilePath, '{}', 'utf8');
}

if (!fs.existsSync(config.proUsersFilePath)) {
  fs.writeFileSync(config.proUsersFilePath, '[]', 'utf8');
}

if (!config.botToken) {
  console.error('ERROR: BOT_TOKEN is not set in .env');
  process.exit(1);
}

module.exports = config;
