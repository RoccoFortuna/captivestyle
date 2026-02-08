#!/bin/bash
set -e

WORKSPACE=/root/workspace
GITHUB_ORG="${GITHUB_ORG}"
REPO_ID="${REPO_ID}"
GIT_TOKEN="${GIT_TOKEN}"
TEMPLATE_REPO_URL="${TEMPLATE_REPO_URL}"

echo "[sandbox] Starting sandbox for repo ${REPO_ID}..."

# 1. Clone the repo
echo "[sandbox] Cloning repo..."
git clone "https://x-access-token:${GIT_TOKEN}@github.com/${GITHUB_ORG}/sandbox-${REPO_ID}.git" "${WORKSPACE}"
cd "${WORKSPACE}"

# 2. If repo is empty (only README from auto_init), clone template and push
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

# 3. Configure git for future commits
git config user.email "sandbox@captivestyle.com"
git config user.name "Sandbox"

# 4. Copy cached node_modules, then install only deltas
echo "[sandbox] Installing dependencies..."
cp -a /root/template-cache/node_modules "${WORKSPACE}/node_modules" 2>/dev/null || true
npm install --prefer-offline

# 5. Start Metro/Expo in background
echo "[sandbox] Starting dev server..."
npx expo start --web --port 3000 &

# 6. Start MCP server (foreground)
echo "[sandbox] Starting MCP server on port ${PORT:-8080}..."
exec node /app/mcp-server/dist/index.js
