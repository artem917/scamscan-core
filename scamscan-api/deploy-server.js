const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const open = require('open').default;

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'deploy-ui')));

const deployUIPath = path.join(__dirname, 'deploy-ui');
if (!fs.existsSync(deployUIPath)) fs.mkdirSync(deployUIPath);

const indexPath = path.join(deployUIPath, 'index.html');
if (!fs.existsSync(indexPath)) {
  fs.writeFileSync(indexPath, `<!DOCTYPE html>
<html>
<head>
<title>ScamScan Deploy</title>
<style>body{font-family:Arial;max-width:600px;margin:50px auto;padding:20px}</style>
</head>
<body>
<h1>Deploy to GitHub</h1>
<textarea id="changelog" rows="10" style="width:100%">## Changes</textarea>
<br><br>
<button onclick="deploy()">Deploy & Push</button>
<p id="status"></p>
<script>
function deploy(){
  fetch('/deploy', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({changelog:document.getElementById('changelog').value})})
  .then(r=>r.json()).then(d=>document.getElementById('status').innerText=d.message)
  .catch(e=>document.getElementById('status').innerText='Error: '+e)
}
</script>
</body>
</html>`);
}

app.post('/deploy', (req, res) => {
  try {
    const { changelog } = req.body;
    execSync(`git add . && git commit -m "Update CHANGELOG" && git push`, { cwd: path.resolve(__dirname, '..') });
    res.json({ message: 'Deployed successfully!' });
  } catch (err) {
    res.json({ message: 'Error: ' + err.message });
  }
});

app.listen(3001, () => {
  console.log('Deploy server running at http://localhost:3001');
  open('http://localhost:3001');
});
