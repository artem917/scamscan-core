const fs = require('fs');
const config = require('../config');

function logFeedback(params) {
  const entry = {
    timestamp: new Date().toISOString(),
    chatId: params.chatId,
    username: params.username || null,
    input: params.input,
    inputType: params.inputType,
    apiResponse: params.apiResponse,
    feedbackText: params.feedbackText
  };

  const line = JSON.stringify(entry) + '\n';

  fs.appendFile(config.feedbackLogPath, line, function (err) {
    if (err) {
      console.error('Failed to write feedback log:', err);
    }
  });
}

module.exports = { logFeedback: logFeedback };
