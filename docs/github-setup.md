# GitHub Setup Guide

One-time setup for the Git backend. Takes ~10 minutes.

## 1. Create GitHub Organization

1. Go to https://github.com/organizations/plan (or click + → New organization)
2. Choose **Free** plan
3. Name: `captivestyle` (or your preferred name)
4. Contact email: your email
5. This org belongs to: **My personal account**

## 2. Create GitHub App

The orchestrator uses a GitHub App (not a personal access token) for auth.
Apps use short-lived tokens and have fine-grained permissions.

1. Go to https://github.com/organizations/captivestyle/settings/apps/new
   (or: Org Settings → Developer settings → GitHub Apps → New GitHub App)

2. Fill in:
   - **App name:** `captivestyle-sandbox-orchestrator`
   - **Homepage URL:** `https://github.com/captivestyle` (anything works)
   - **Webhook:** Uncheck "Active" (we don't need webhooks)

3. **Permissions** (Repository permissions only):
   - **Contents:** Read & write (clone, push)
   - **Metadata:** Read-only (required, auto-selected)
   - **Administration:** Read & write (create/delete repos)

4. **Where can this app be installed?** → Only on this account

5. Click **Create GitHub App**

6. Note down the **App ID** (shown on the app's settings page)

## 3. Generate Private Key

1. On the App settings page, scroll to **Private keys**
2. Click **Generate a private key**
3. A `.pem` file downloads — keep this safe
4. Base64 encode it for use as an env var:
   ```bash
   cat path/to/downloaded-key.pem | base64 | tr -d '\n'
   ```
5. Save the base64 string — this becomes `GITHUB_APP_PRIVATE_KEY`

## 4. Install App on Organization

1. On the App settings page, click **Install App** (left sidebar)
2. Click **Install** next to your org
3. Choose **All repositories** (so it can manage repos it creates)
4. Click **Install**
5. After install, the URL will contain the **Installation ID**:
   `https://github.com/organizations/captivestyle/settings/installations/XXXXXXX`
   Note down that number.

## 5. Summary of Values

You'll need these for the orchestrator's environment variables:

| Variable | Where to find it |
|----------|-----------------|
| `GITHUB_APP_ID` | App settings page, top section |
| `GITHUB_APP_PRIVATE_KEY` | Base64 of the `.pem` file downloaded in step 3 |
| `GITHUB_INSTALLATION_ID` | URL after installing the app (step 4) |
| `GITHUB_ORG` | The org name, e.g. `captivestyle` |
| `TEMPLATE_REPO_URL` | `https://github.com/RoccoFortuna/3d-game-sandbox-template` |

## 6. Verify Setup

Test that the app can create repos:

```bash
# 1. Load env vars and write temp PEM file:
source .env
echo "$GITHUB_APP_PRIVATE_KEY" | base64 -d > /tmp/_gh_app_key.pem

# 2. Generate an installation token:
TOKEN=$(npx github-app-installation-token \
  --appId $GITHUB_APP_ID \
  --installationId $GITHUB_INSTALLATION_ID \
  --privateKeyLocation /tmp/_gh_app_key.pem)
rm /tmp/_gh_app_key.pem
echo "Token: ${TOKEN:0:10}..."

# 3. Test repo creation:
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/orgs/$GITHUB_ORG/repos \
  -d '{"name":"test-repo","private":true}'

# 4. Clean up:
curl -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$GITHUB_ORG/test-repo
```
