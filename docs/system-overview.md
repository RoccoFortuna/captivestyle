# CaptiveStyle Sandbox Infrastructure

Self-hosted replacement for freestyle.sh — provides Git-backed sandboxes with ephemeral dev servers and MCP tool access, running on GCP Cloud Run.

## Architecture

```
Client (bloom3d2 / Convex)
    |
    | SandboxClient (npm package)
    v
Orchestrator API (Cloud Run, scales to zero)
    |
    +-- GitHub API (create/delete repos via GitHub App)
    |
    +-- Cloud Run Admin API (create/delete sandbox containers)
    |
    v
Sandbox Container (Cloud Run, one per repo)
    |
    +-- /health          -> health check
    +-- /mcp (POST)      -> MCP tools (list_directory, read_file, write_file, exec, npm_install)
    +-- /* (GET/WS)      -> Metro/Expo dev server (reverse proxied from port 3000)
```

## Components

### 1. Orchestrator (`infra/services/orchestrator/`)

Stateless REST API that manages sandbox lifecycle. Runs on Cloud Run, scales to zero when idle.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/repos` | Create a new Git repo on GitHub |
| `POST` | `/repos/:repoId/devserver` | Spin up a sandbox container |
| `POST` | `/repos/:repoId/commit` | Git commit + push from sandbox |
| `GET` | `/repos/:repoId/status` | Check if sandbox is running |

All endpoints (except `/health`) require `Authorization: Bearer <API_SECRET>`.

**Create repo request:**
```json
{ "name": "my-project" }
```

**Create devserver request:**
```json
{ "templateRepoUrl": "https://github.com/user/template-repo" }
```

**Commit request:**
```json
{ "message": "Update game logic" }
```

### 2. Sandbox Container (`infra/services/sandbox/`)

One container per sandbox repo. Runs on Cloud Run with always-on CPU, scales to zero after ~15 min idle.

**Startup sequence (~7-12s cold start):**
1. Configure git identity
2. Clone the GitHub repo to `/root/workspace`
3. If repo is empty, clone the template repo and push initial commit
4. Copy pre-baked `node_modules` from container image, run `npm install` for deltas
5. Start Expo Metro dev server on port 3000 (background)
6. Start MCP server on port 8080 (foreground)

**MCP tools available (stateless, no session required):**

| Tool | Input | Description |
|------|-------|-------------|
| `list_directory` | `{ path }` | List files/dirs at path |
| `read_file` | `{ path }` | Read file contents |
| `write_file` | `{ path, content, encoding? }` | Write file (creates dirs) |
| `exec` | `{ command }` | Run shell command (120s timeout) |
| `npm_install` | `{ packages }` | Install npm packages |

MCP endpoint is stateless — each POST to `/mcp` creates a fresh server+transport. No session ID needed.

### 3. GitHub (Git Storage)

- Organization: `captivestyle` (free tier — 100K repos, unlimited private)
- GitHub App for authentication (no PATs)
- Repos named `sandbox-{repoId}`
- Each sandbox clones its repo on startup and can push commits

### 4. Infrastructure (Pulumi)

All infrastructure defined in `infra/` using Pulumi + `@pulumi/gcp`:

| Component | File | Resource |
|-----------|------|----------|
| Artifact Registry | `components/sandbox-image.ts` | Docker image storage |
| IAM | `components/iam.ts` | Service accounts + roles |
| Secrets | `components/secrets.ts` | Secret Manager (API key, GitHub App creds) |
| Orchestrator | `components/orchestrator.ts` | Cloud Run service |

**Service accounts:**
- `orchestrator` — `run.admin`, `artifactregistry.reader`, `iam.serviceAccountUser`, `secretmanager.secretAccessor`
- `sandbox` — minimal (for future use)

### 5. Client Library (`packages/sandbox-client/`)

Drop-in replacement for `freestyle-sandboxes` npm package.

```typescript
import { SandboxClient } from "@captivestyle/sandbox-client";

const client = new SandboxClient({
  apiKey: "your-api-secret",
  baseUrl: "https://orchestrator-xxx.europe-west1.run.app",
});

// Create a repo
const { repoId } = await client.createGitRepository({
  name: "my-game",
  source: { url: "https://github.com/user/template", type: "git" },
});

// Start dev server
const server = await client.requestDevServer({
  repoId,
  templateRepoUrl: "https://github.com/user/template",
});

console.log(server.ephemeralUrl);    // Preview URL
console.log(server.mcpEphemeralUrl); // MCP endpoint

// Commit changes
await server.commitAndPush("Update game logic");
```

## Deployment

### Prerequisites
- GCP project with Cloud Run, Artifact Registry, Secret Manager APIs enabled
- GitHub organization with GitHub App installed
- `.env` file with credentials (see `.env.example` pattern in `docs/github-setup.md`)

### Build & Deploy

```bash
# Build and push Docker images
make build-all

# Deploy infrastructure
make deploy

# Populate secrets (first time only)
make secrets

# Full pipeline
make ship
```

### Environment Variables

**Orchestrator (injected via Pulumi/Secret Manager):**
- `GCP_PROJECT_ID` — GCP project
- `GCP_REGION` — e.g. `europe-west1`
- `GITHUB_ORG` — GitHub organization name
- `GITHUB_APP_ID` — GitHub App ID (secret)
- `GITHUB_APP_PRIVATE_KEY` — Base64-encoded private key (secret)
- `GITHUB_INSTALLATION_ID` — Installation ID (secret)
- `API_SECRET` — Bearer token for API auth (secret)
- `SANDBOX_IMAGE_URL` — Artifact Registry URL for sandbox image

**Sandbox (injected per-container by orchestrator):**
- `REPO_ID` — Repository identifier
- `GIT_TOKEN` — Short-lived GitHub installation token
- `GITHUB_ORG` — GitHub organization name
- `TEMPLATE_REPO_URL` — Template repo to clone for new sandboxes
- `PRESET` — Dev server preset (default: `expo`)

## Cost

- Base (idle): ~$3/month
- Per active sandbox: ~$0.10/hour (2 CPU, 4GB RAM)
- Example: 10 sandboxes x 4 hrs/day = ~$123/month total

## Current Deployment

- **Region:** europe-west1
- **Orchestrator:** `https://orchestrator-802615778370.europe-west1.run.app`
- **Pulumi state:** `gs://captivestyle-pulumi-state`
- **Artifact Registry:** `europe-west1-docker.pkg.dev/captivestyle-dev/sandbox`
