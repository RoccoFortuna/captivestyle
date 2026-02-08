# Freestyle.sh Replacement: Self-Hosted Sandbox Infrastructure

## Problem

bloom3d2 depends on freestyle.sh for ephemeral dev sandboxes. The service has
reliability issues (frequent downtime) and represents a single point of failure
for the entire product. We need a self-hosted replacement on GCP using Pulumi
that recreates **only** the functionality we actually use.

---

## What We Actually Use from Freestyle

### 1. Git Repository Hosting

**API surface consumed:**
```ts
freestyle.createGitRepository({
  name: string,
  public: boolean,
  source: { url: string, type: "git" },  // clones a template repo
  devServers: { preset: "expo" },
})
// Returns: { repoId: string }
```

**What it does:**
- Creates a bare Git repo on freestyle's servers
- Clones a template repo (github.com/RoccoFortuna/3d-game-sandbox-template) as initial content
- Repo is accessible at `https://git.freestyle.sh/{repoId}`
- Public repos are cloneable

### 2. Ephemeral Dev Servers

**API surface consumed:**
```ts
freestyle.requestDevServer({
  repoId: string,
  repoUrl: string,  // https://git.freestyle.sh/{repoId}
})
// Returns: {
//   ephemeralUrl: string,    // preview URL (live app)
//   mcpEphemeralUrl: string, // MCP service endpoint
// }

devServer.commitAndPush(message: string)
```

**What it does:**
- Spins up a container running the repo's code with the Expo dev preset
- Runs `npm install` and starts Metro bundler automatically
- Provides a public preview URL for the running app
- Exposes an MCP endpoint for tool access
- Auto-shuts down after ~15 minutes of inactivity
- On re-request, returns existing server or creates new one from same repo

### 3. MCP Service (on each dev server)

**Tools exposed via MCP (StreamableHTTP transport):**
- `list_directory` - List files at a path
- `read_file` - Read file contents
- `write_file` - Write file (supports base64 encoding for binary)
- `exec` - Execute shell commands
- `npm_install` - Install npm packages

### 4. NOT Used (can skip)

- `freestyle.deployWeb()` - Production deployments to `*.style.dev`
- Custom domains API
- Git triggers / CI/CD webhooks
- FreestyleDevServer React component (we have our own preview)

---

## Replacement Architecture

```
                    ┌─────────────────────────────────────────┐
                    │          Convex Backend (existing)       │
                    │                                          │
                    │  sessionActions.ts   agent.ts            │
                    │       │                 │                │
                    │       ▼                 ▼                │
                    │  ┌─────────────────────────────┐        │
                    │  │  sandbox-client.ts           │        │
                    │  │  (drop-in freestyle.ts       │        │
                    │  │   replacement)               │        │
                    │  └──────────┬──────────────────┘        │
                    └─────────────┼────────────────────────────┘
                                  │ HTTPS
                                  ▼
                    ┌─────────────────────────────────────────┐
                    │     Sandbox Orchestrator API             │
                    │     (Cloud Run, scale-to-zero)           │
                    │                                          │
                    │  POST /repos          → create GH repo   │
                    │  POST /repos/:id/dev  → request sandbox  │
                    │  POST /repos/:id/commit → commit+push    │
                    │  GET  /repos/:id/status                  │
                    │                                          │
                    │  State: stateless — derives sandbox      │
                    │  service names from repoId by convention │
                    │  (sandbox-{repoId}), queries Cloud Run   │
                    │  Admin API for existence/URLs on demand   │
                    └──────────┬──────────────────────────────┘
                               │
              ┌────────────────┼──────────────────┐
              ▼                ▼                    ▼
   ┌──────────────┐  ┌──────────────────┐  ┌──────────────┐
   │  GitHub Org   │  │  Cloud Run       │  │  Artifact    │
   │  (Git repos)  │  │  (sandboxes)     │  │  Registry    │
   │               │  │  scale-to-zero   │  │  (base img)  │
   └──────────────┘  └───────┬──────────┘  └──────────────┘
                             │
                     ┌───────┴───────┐
                     │  Each sandbox │
                     │  container:   │
                     │               │
                     │  - Git clone  │
                     │  - Metro dev  │
                     │  - MCP server │
                     │  - Preview    │
                     └───────────────┘
```

**3 components total.** No Firestore. No Gitea. No load balancer.

---

## Component Design

### Component 1: Git — GitHub Organization

**Service:** GitHub (free org, e.g. `captivestyle`)

**Why GitHub instead of custom Git server:**
- Free, unlimited private repos (100K cap per org — irrelevant for us)
- Extremely reliable (vs freestyle.sh or self-hosted Gitea)
- Zero infra to manage
- GitHub App for auth (short-lived tokens, fine-grained permissions)
- API rate: 5,000 req/hr (PAT) or up to 12,500 req/hr (GitHub App)
- Repo creation: ~80/min, ~500/hr — more than enough

**Why not custom `git-http-backend` on Cloud Run:**
- It works, but adds a service to maintain, a persistent disk, and networking
- We'd build it only if we outgrow GitHub (thousands of repos, ToS concerns)
- Kept as documented fallback option (see Appendix A)

**Operations:**
```
Create repo:
  POST https://api.github.com/orgs/captivestyle/repos
  Body: { name: "{repoId}", private: true, auto_init: false }
  Then: clone template, push to new repo

Clone from sandbox:
  git clone https://x-access-token:{token}@github.com/captivestyle/{repoId}.git

Push from sandbox:
  git push (using same token)
```

**Auth:** GitHub App installed on the org. Orchestrator generates short-lived
installation tokens on demand. Tokens are passed to sandbox containers as env
vars at creation time.

**Pulumi resources:** None. GitHub org + App created manually once.

### Component 2: Sandbox Orchestrator API

**GCP service:** Cloud Run (scale-to-zero, min instances = 0)

A lightweight Node.js/TypeScript API. ~300 lines of code. **Stateless** — all
state is derived:

- Repo exists? → GitHub API check
- Sandbox running? → Cloud Run Admin API: check if service `sandbox-{repoId}` exists
- Sandbox URL? → Cloud Run service URL (deterministic: `https://sandbox-{repoId}-{hash}.a.run.app`)

**Cold start:** ~1-2s for a lightweight Node.js API. Acceptable because these
calls are triggered during session create/resume, not during real-time chat.

**Endpoints:**

```
POST /repos
  1. Generate repoId (nanoid)
  2. Create GitHub repo from template
  3. Return { repoId }

POST /repos/:repoId/devserver
  1. Check if Cloud Run service "sandbox-{repoId}" exists (Admin API)
  2. If running: return its URL
  3. If not: create new Cloud Run service with env vars:
     - REPO_URL=https://github.com/captivestyle/{repoId}.git
     - GIT_TOKEN={freshly generated GitHub App installation token}
     - PRESET=expo
  4. Wait for service to become healthy (poll readiness)
  5. Return { ephemeralUrl, mcpUrl }

POST /repos/:repoId/commit
  1. Proxy to sandbox MCP: exec("cd /root/workspace && git add -A && git commit -m '{msg}' && git push")
  2. Return { success }

GET /repos/:repoId/status
  1. Check Cloud Run service status
  2. Return { status: "running" | "stopped" | "starting" }
```

**Auth:** Bearer token in Authorization header. Single shared secret for now
(orchestrator ↔ Convex). Can add API key management later.

**Pulumi resources:**
```
- Cloud Run service (orchestrator)
- IAM: Cloud Run Admin role (to create/delete sandbox services)
- IAM: Artifact Registry Reader (to pull sandbox images)
- Secret Manager: GitHub App private key, shared API secret
```

### Component 3: Sandbox Container (Dev Server)

**GCP service:** Cloud Run (one service per sandbox, scale-to-zero)

Each sandbox is a Cloud Run service with:
- **Always-on CPU** (Metro needs continuous CPU for file watching)
- **Startup CPU boost** enabled (default, gives extra CPU for first 10s)
- **Scale to zero** after ~15 min idle (Cloud Run's natural behavior)
- **Public URL** for preview (Cloud Run provides HTTPS URL automatically)

**Container image** (pre-built, stored in Artifact Registry):

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Pre-bake template node_modules to eliminate npm install on cold start
WORKDIR /root/template-cache
COPY template-package.json ./package.json
COPY template-package-lock.json ./package-lock.json
RUN npm ci

# MCP server
WORKDIR /app/mcp-server
COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci
COPY mcp-server/ .

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
```

**Startup flow (~5-10s with pre-baked node_modules):**

```bash
#!/bin/bash
set -e

WORKSPACE=/root/workspace

# 1. Clone repo (~1-2s)
git clone https://x-access-token:${GIT_TOKEN}@github.com/captivestyle/${REPO_ID}.git $WORKSPACE

# 2. Copy cached node_modules, then install only deltas (~1-2s)
cp -a /root/template-cache/node_modules $WORKSPACE/node_modules
cd $WORKSPACE
npm install --prefer-offline  # only installs packages added since template

# 3. Start Metro in background
npx expo start --web --port 3000 &

# 4. Start reverse proxy + MCP server (foreground, port 8080)
#    Routes /mcp/* → MCP handler
#    Routes /*     → localhost:3000 (Metro)
node /app/mcp-server/index.js
```

**Single port (8080) serves both preview and MCP:**
- `GET /` and all non-MCP paths → reverse proxy to Metro (port 3000)
- `POST /mcp` → MCP StreamableHTTP handler

This way Cloud Run's single public URL works for both preview and MCP:
- `ephemeralUrl` = `https://sandbox-{repoId}-{hash}.a.run.app`
- `mcpUrl` = `https://sandbox-{repoId}-{hash}.a.run.app/mcp`

**Cold start breakdown:**
| Step | Time |
|------|------|
| Cloud Run scheduling + image pull | ~2-3s (cached image) |
| Git clone (small repo) | ~1-2s |
| Copy cached node_modules + npm install delta | ~1-2s |
| Metro start (first bundle) | ~3-5s |
| **Total** | **~7-12s** |

This is faster than freestyle.sh's typical 30-60s spin-up.

### MCP Server (inside sandbox container)

Minimal Node.js MCP server implementing the 5 tools. Serves both MCP and
reverse-proxies Metro on the same port.

```ts
// mcp-server/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import httpProxy from "http-proxy-middleware";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { resolve, dirname } from "path";

const exec = promisify(execCb);
const WORKSPACE = "/root/workspace";
const app = express();

// --- MCP Server ---
const mcp = new McpServer({ name: "sandbox-mcp", version: "1.0.0" });

mcp.tool("list_directory", { path: z.string() }, async ({ path }) => {
  const entries = await readdir(resolve(WORKSPACE, path), { withFileTypes: true });
  const listing = entries.map(e =>
    `${e.isDirectory() ? 'd' : '-'} ${e.name}`
  ).join('\n');
  return { content: [{ type: "text", text: listing }] };
});

mcp.tool("read_file", { path: z.string() }, async ({ path }) => {
  const content = await readFile(resolve(WORKSPACE, path), "utf-8");
  return { content: [{ type: "text", text: content }] };
});

mcp.tool("write_file",
  { path: z.string(), content: z.string(), encoding: z.string().optional() },
  async ({ path, content, encoding }) => {
    const fullPath = resolve(WORKSPACE, path);
    await mkdir(dirname(fullPath), { recursive: true });
    const data = encoding === "base64" ? Buffer.from(content, "base64") : content;
    await writeFile(fullPath, data);
    return { content: [{ type: "text", text: "OK" }] };
  }
);

mcp.tool("exec", { command: z.string() }, async ({ command }) => {
  const { stdout, stderr } = await exec(command, {
    cwd: WORKSPACE,
    timeout: 120000,
  });
  return { content: [{ type: "text", text: stdout + stderr }] };
});

mcp.tool("npm_install", { packages: z.string() }, async ({ packages }) => {
  const { stdout, stderr } = await exec(
    `npm install ${packages}`,
    { cwd: WORKSPACE, timeout: 120000 }
  );
  return { content: [{ type: "text", text: stdout + stderr }] };
});

// Mount MCP on /mcp
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
app.use("/mcp", transport.requestHandler);
mcp.connect(transport);

// Proxy everything else to Metro (port 3000)
app.use("/", httpProxy.createProxyMiddleware({
  target: "http://localhost:3000",
  ws: true,  // WebSocket support for hot reload
}));

app.listen(8080, () => console.log("Sandbox ready on :8080"));
```

### Idle Shutdown

**Cloud Run handles this natively.** With always-on CPU allocation and
min-instances=0, Cloud Run keeps the instance alive as long as there are active
connections or recent requests. After ~15 minutes of no traffic, it scales to
zero. The instance is destroyed, and next request triggers a cold start.

No Cloud Scheduler, no cleanup cron, no Firestore tracking needed.

If we need more aggressive cleanup (e.g., delete the Cloud Run *service* itself
after days of inactivity to avoid cluttering the project), the orchestrator can
do this lazily: when a dev server is requested, check if a stale service exists
and delete it before creating a new one.

---

## Pulumi Infrastructure Code Structure

```
captivestyle/
├── infra/
│   ├── Pulumi.yaml
│   ├── Pulumi.dev.yaml
│   ├── Pulumi.prod.yaml
│   ├── index.ts                  # Main stack
│   ├── components/
│   │   ├── orchestrator.ts       # Orchestrator Cloud Run service
│   │   ├── sandbox-image.ts      # Artifact Registry + Docker build
│   │   ├── iam.ts                # Service accounts, roles
│   │   └── secrets.ts            # Secret Manager entries
│   └── services/
│       ├── orchestrator/         # Orchestrator API source
│       │   ├── Dockerfile
│       │   ├── package.json
│       │   └── src/
│       │       ├── index.ts
│       │       ├── routes/
│       │       │   ├── repos.ts
│       │       │   └── devservers.ts
│       │       └── lib/
│       │           ├── github-client.ts
│       │           └── sandbox-manager.ts  # Cloud Run Admin API wrapper
│       └── sandbox/              # Sandbox container source
│           ├── Dockerfile
│           ├── entrypoint.sh
│           ├── template-package.json      # From template repo, for pre-baking
│           ├── template-package-lock.json
│           └── mcp-server/
│               ├── package.json
│               └── index.ts
├── packages/
│   └── sandbox-client/           # Drop-in replacement for freestyle-sandboxes
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts
└── docs/
    └── freestyle-replacement-design.md  # This file
```

---

## Drop-in Client Replacement

The client that bloom3d2 consumes. Replaces `freestyle-sandboxes`:

```ts
// packages/sandbox-client/src/index.ts

export class SandboxClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(opts: { apiKey: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl || "https://orchestrator-xxx.a.run.app";
  }

  async createGitRepository(opts: {
    name: string;
    public: boolean;
    source: { url: string; type: "git" };
    devServers: { preset: string };
  }): Promise<{ repoId: string }> {
    const res = await fetch(`${this.baseUrl}/repos`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(opts),
    });
    return res.json();
  }

  async requestDevServer(opts: {
    repoId: string;
    repoUrl?: string;
  }): Promise<{
    ephemeralUrl: string;
    mcpEphemeralUrl: string;
    commitAndPush: (message: string) => Promise<void>;
  }> {
    const res = await fetch(`${this.baseUrl}/repos/${opts.repoId}/devserver`, {
      method: "POST",
      headers: this.headers(),
    });
    const data = await res.json();

    return {
      ephemeralUrl: data.ephemeralUrl,
      mcpEphemeralUrl: data.mcpUrl,
      commitAndPush: async (message: string) => {
        await fetch(`${this.baseUrl}/repos/${opts.repoId}/commit`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ message }),
        });
      },
    };
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}
```

**Migration in bloom3d2** — change one file:
```diff
// convex/freestyle.ts
-import { FreestyleSandboxes } from "freestyle-sandboxes";
+import { SandboxClient } from "@captivestyle/sandbox-client";

-const freestyle = new FreestyleSandboxes({
+const freestyle = new SandboxClient({
   apiKey: process.env.FREESTYLE_API_KEY!,
+  baseUrl: process.env.SANDBOX_API_URL!,
 });
```

Everything else (sessionActions.ts, agent.ts) stays unchanged.

---

## GCP Cost Estimate

| Component | GCP Service | Monthly Cost |
|-----------|-------------|-------------|
| Orchestrator | Cloud Run (scale-to-zero, ~100 req/day) | ~$0-2 |
| Sandbox containers | Cloud Run (2 vCPU, 4GB, always-on CPU) | ~$0.10/hr each |
| Artifact Registry | Container images (~1GB) | ~$1 |
| Secret Manager | 2-3 secrets | ~$0 |
| GitHub | Free org | $0 |
| **Total (idle)** | | **~$3/mo** |
| **Per sandbox hour** | | **~$0.10** |

10 sandboxes x 4 hrs/day x 30 days = **~$3 base + $120 sandbox = ~$123/mo**

Compared to original design: eliminated ~$50/mo in always-on Gitea + orchestrator + load balancer + Firestore.

---

## Implementation Phases

### Phase 1: MVP (get it working)
1. Set up GitHub org + GitHub App
2. Build sandbox container (Dockerfile + MCP server + entrypoint)
3. Build orchestrator API (repo creation, sandbox lifecycle via Cloud Run Admin API)
4. Pulumi stack for orchestrator + Artifact Registry + IAM
5. Build SandboxClient package
6. Test end-to-end with bloom3d2

### Phase 2: Polish
- Pre-bake template node_modules in sandbox image
- Health check endpoint in sandbox (for orchestrator to poll readiness)
- Structured logging (Cloud Logging)
- Error handling in orchestrator (retries, timeouts)

### Phase 3: Hardening (when needed)
- Rate limiting on orchestrator
- Sandbox resource limits (CPU/memory caps per service)
- Stale service cleanup (delete Cloud Run services unused for N days)
- Custom domain for orchestrator (optional)
- Fallback: custom git-http-backend if GitHub becomes a bottleneck

---

## Appendix A: Custom Git Server Fallback

If GitHub becomes limiting (ToS concerns at scale, rate limits, etc.), replace
with a minimal `git-http-backend` on Cloud Run:

- Container: nginx + git-http-backend (~13MB image)
- Storage: Cloud Filestore mount (persistent NFS)
- Create repo = `git init --bare /repos/{repoId}.git`
- No database, no UI, no application logic
- ~$15/mo additional (Cloud Run + Filestore)

This is a drop-in replacement for the GitHub component. The orchestrator's
`github-client.ts` would be swapped for a `git-server-client.ts` that creates
bare repos via the git server's API instead of GitHub's.
