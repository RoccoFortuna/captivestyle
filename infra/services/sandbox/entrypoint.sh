#!/bin/bash
set -e

WORKSPACE=/root/workspace
GITHUB_ORG="${GITHUB_ORG}"
REPO_ID="${REPO_ID}"
TEMPLATE_REPO_URL="${TEMPLATE_REPO_URL}"

echo "[sandbox] Starting sandbox for repo ${REPO_ID}..."

# 0. Generate a fresh GitHub installation token (the one from env may be expired)
echo "[sandbox] Generating fresh GitHub token..."
GIT_TOKEN=$(node -e "
const crypto = require('crypto');
const https = require('https');

const appId = process.env.GITHUB_APP_ID;
const privateKey = Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY, 'base64').toString('utf-8');
const installationId = process.env.GITHUB_INSTALLATION_ID;

// Create JWT
const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })).toString('base64url');
const signature = crypto.sign('RSA-SHA256', Buffer.from(header + '.' + payload), privateKey).toString('base64url');
const jwt = header + '.' + payload + '.' + signature;

// Exchange JWT for installation token
const req = https.request({
  hostname: 'api.github.com',
  path: '/app/installations/' + installationId + '/access_tokens',
  method: 'POST',
  headers: { Authorization: 'Bearer ' + jwt, 'User-Agent': 'sandbox', Accept: 'application/vnd.github+json' },
}, (res) => {
  let data = '';
  res.on('data', (c) => data += c);
  res.on('end', () => {
    const { token } = JSON.parse(data);
    if (!token) { console.error(data); process.exit(1); }
    process.stdout.write(token);
  });
});
req.end();
")

# 1. Configure git identity
git config --global user.email "sandbox@captivestyle.com"
git config --global user.name "Sandbox"
git config --global init.defaultBranch main

# 2. Clone the repo
echo "[sandbox] Cloning repo..."
git clone "https://x-access-token:${GIT_TOKEN}@github.com/${GITHUB_ORG}/sandbox-${REPO_ID}.git" "${WORKSPACE}"
cd "${WORKSPACE}"

# 3. If repo is empty (only README from auto_init), clone template and push
FILE_COUNT=$(ls -1 | wc -l)
if [ "$FILE_COUNT" -le 1 ]; then
  echo "[sandbox] Repo is empty — cloning template from ${TEMPLATE_REPO_URL}..."
  git clone "${TEMPLATE_REPO_URL}" /tmp/template
  cp -a /tmp/template/. "${WORKSPACE}/"
  rm -rf "${WORKSPACE}/.git"
  cd "${WORKSPACE}"
  git init
  git remote add origin "https://x-access-token:${GIT_TOKEN}@github.com/${GITHUB_ORG}/sandbox-${REPO_ID}.git"
  git add -A
  git commit -m "Initialize from template"
  git push -u origin main --force
  rm -rf /tmp/template
fi

# 3. Copy cached node_modules, then install only deltas
echo "[sandbox] Installing dependencies..."
cp -a /root/template-cache/node_modules "${WORKSPACE}/node_modules" 2>/dev/null || true
npm install --prefer-offline

# 5. Start Metro/Expo in background
echo "[sandbox] Starting dev server..."
npx expo start --web --port 3000 &

# 6. Start MCP server (foreground)
echo "[sandbox] Starting MCP server on port ${PORT:-8080}..."
exec node /app/mcp-server/dist/index.js
