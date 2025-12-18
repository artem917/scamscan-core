const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = 3001;

// Папка с HTML формой деплоя
const deployUIPath = '/var/www/deploy-ui';

app.use(express.static(deployUIPath));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Обработка формы: текст -> git commit + push
app.post('/deploy', (req, res) => {
  const message = (req.body.message || '').trim();
  if (!message) {
    return res.status(400).send('Commit message is required');
  }

  // Репозиторий — текущая папка scamscan-api (монорепа под /var/www уже настроена)
  const cmd = `
    cd /var/www &&
    git add . &&
    git commit -m "${message.replace(/"/g, '\\"')}" &&
    git push
  `;

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error('Deploy error:', error);
      console.error(stderr);
      return res.status(500).send('Deploy failed: ' + stderr);
    }
    console.log('Deploy output:', stdout);
    res.send('Deploy & Push OK');
  });
});

app.listen(PORT, () => {
  console.log('Deploy UI server listening on http://localhost:' + PORT);
});
