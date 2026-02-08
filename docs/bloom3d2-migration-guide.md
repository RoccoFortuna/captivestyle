# Migrating bloom3d2 from freestyle.sh to CaptiveStyle

This guide covers adding `@captivestyle/sandbox-client` alongside `freestyle-sandboxes` in bloom3d2, with a single env var to switch between backends.

## What Changes

| | freestyle.sh | CaptiveStyle |
|---|---|---|
| Package | `freestyle-sandboxes` | `@captivestyle/sandbox-client` |
| Auth | `FREESTYLE_API_KEY` | `CAPTIVESTYLE_API_KEY` + `CAPTIVESTYLE_API_URL` |
| Git repos | Hosted on freestyle.sh | Hosted on GitHub (`captivestyle` org) |
| Dev server URLs | `*.freestyle.sh` | `*.europe-west1.run.app` |
| MCP transport | StreamableHTTP (same) | StreamableHTTP (same, stateless) |
| MCP tools | Same 5 tools | Same 5 tools (list_directory, read_file, write_file, exec, npm_install) |

## Step 1: Install the client

Keep `freestyle-sandboxes` and add `@captivestyle/sandbox-client`:

```bash
# Option A: npm link (local dev)
cd /path/to/captivestyle/packages/sandbox-client && npm link
cd /path/to/bloom3d2 && npm link @captivestyle/sandbox-client

# Option B: file reference in package.json
# "dependencies": {
#   "@captivestyle/sandbox-client": "file:../captivestyle/packages/sandbox-client"
# }
```

## Step 2: Set environment variables

Add to your Convex environment (`.env` or Convex dashboard):

```bash
# Keep existing
FREESTYLE_API_KEY=...

# Add
CAPTIVESTYLE_API_KEY=<your API_SECRET from captivestyle .env>
CAPTIVESTYLE_API_URL=https://orchestrator-802615778370.europe-west1.run.app

# Switch backend: "captivestyle" or "freestyle"
SANDBOX_BACKEND=captivestyle
```

Set `SANDBOX_BACKEND=freestyle` to switch back to freestyle.sh at any time.

## Step 3: Replace `convex/freestyle.ts`

Replace the entire file with a configurable adapter:

```typescript
"use node";
import { FreestyleSandboxes } from "freestyle-sandboxes";
import { SandboxClient } from "@captivestyle/sandbox-client";

const BACKEND = process.env.SANDBOX_BACKEND || "freestyle";
const TEMPLATE_REPO_URL = "https://github.com/RoccoFortuna/3d-game-sandbox-template";

// --- Freestyle backend ---

const freestyle = new FreestyleSandboxes({
  apiKey: process.env.FREESTYLE_API_KEY || "",
});

async function freestyleCreateRepo(): Promise<string> {
  const { repoId } = await freestyle.createGitRepository({
    name: "Convex Agent Repo",
    public: true,
    source: { url: TEMPLATE_REPO_URL, type: "git" },
    devServers: { preset: "expo" },
  } as any);
  return repoId;
}

async function freestyleCreateDevServer(repoId: string) {
  const response: any = await freestyle.requestDevServer({
    repoId,
    repoUrl: `https://git.freestyle.sh/${repoId}`,
  });
  return {
    mcpUrl: response.mcpEphemeralUrl,
    appUrl: response.ephemeralUrl || response.url,
    devServerInstance: response,
  };
}

async function freestyleCommitAndPush(repoId: string, message: string) {
  const devServer = await freestyle.requestDevServer({
    repoId,
    repoUrl: `https://git.freestyle.sh/${repoId}`,
  });
  await devServer.commitAndPush(message);
}

// --- CaptiveStyle backend ---

const captivestyle = new SandboxClient({
  apiKey: process.env.CAPTIVESTYLE_API_KEY || "",
  baseUrl: process.env.CAPTIVESTYLE_API_URL || "",
});

async function captivestyleCreateRepo(): Promise<string> {
  const { repoId } = await captivestyle.createGitRepository({
    name: "Convex Agent Repo",
    public: true,
    source: { url: TEMPLATE_REPO_URL, type: "git" },
    devServers: { preset: "expo" },
  });
  return repoId;
}

async function captivestyleCreateDevServer(repoId: string) {
  const response = await captivestyle.requestDevServer({
    repoId,
    templateRepoUrl: TEMPLATE_REPO_URL,
  });
  return {
    mcpUrl: response.mcpEphemeralUrl,
    appUrl: response.ephemeralUrl,
    devServerInstance: response,
  };
}

async function captivestyleCommitAndPush(repoId: string, message: string) {
  const devServer = await captivestyle.requestDevServer({
    repoId,
    templateRepoUrl: TEMPLATE_REPO_URL,
  });
  await devServer.commitAndPush(message);
}

// --- Public API (unchanged exports) ---

export const createRepo = async () => {
  console.log(`[Sandbox:${BACKEND}] Creating repo...`);
  try {
    const repoId =
      BACKEND === "captivestyle"
        ? await captivestyleCreateRepo()
        : await freestyleCreateRepo();
    console.log(`[Sandbox:${BACKEND}] Repo created:`, repoId);
    return repoId;
  } catch (error) {
    console.error(`[Sandbox:${BACKEND}] Failed to create repo:`, error);
    throw new Error(
      `Failed to create repository: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }`
    );
  }
};

export const createDevServer = async (repoId: string) => {
  console.log(`[Sandbox:${BACKEND}] Requesting dev server for repo: ${repoId}...`);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Dev server creation timed out after 3 minutes")),
      180000
    );
  });

  try {
    const result: any = await Promise.race([
      BACKEND === "captivestyle"
        ? captivestyleCreateDevServer(repoId)
        : freestyleCreateDevServer(repoId),
      timeout,
    ]);

    if (timeoutId) clearTimeout(timeoutId);

    console.log(`[Sandbox:${BACKEND}] Dev server response:`, JSON.stringify(result, null, 2));

    if (!result.mcpUrl) {
      throw new Error(`No MCP URL in response: ${JSON.stringify(result)}`);
    }
    if (!result.appUrl) {
      throw new Error(`No app URL in response: ${JSON.stringify(result)}`);
    }

    return result;
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    console.error(`[Sandbox:${BACKEND}] Failed to create dev server for repo ${repoId}:`, error);
    throw error;
  }
};

export const commitAndPush = async (repoId: string, message: string) => {
  console.log(`[Sandbox:${BACKEND}] Committing to repo: ${repoId}`);

  if (BACKEND === "captivestyle") {
    await captivestyleCommitAndPush(repoId, message);
  } else {
    await freestyleCommitAndPush(repoId, message);
  }

  console.log(`[Sandbox:${BACKEND}] Committed: ${message}`);
};
```

## Step 4: No changes needed in other files

| File | Change needed? |
|------|---------------|
| `convex/agent.ts` | No — MCP connection uses `mcpUrl` from `createDevServer`, works with both backends |
| `convex/sessionActions.ts` | No — imports `createRepo`/`createDevServer` which have the same signatures |

## Switching backends

```bash
# Use CaptiveStyle
SANDBOX_BACKEND=captivestyle

# Use freestyle.sh
SANDBOX_BACKEND=freestyle
```

That's it. One env var swap, no code changes.

## Key differences to be aware of

1. **Template repo URL is explicit** — CaptiveStyle requires `templateRepoUrl` on devserver creation. This is handled in the adapter.

2. **Git URLs differ** — CaptiveStyle repos are on GitHub (`github.com/captivestyle/sandbox-{repoId}`). If you display repo URLs to users, note they'll differ between backends.

3. **Dev server URLs differ** — `*.europe-west1.run.app` vs `*.freestyle.sh`.

4. **Cold start** — CaptiveStyle sandbox first boot takes ~30-120s (Cloud Run + git clone + npm install). Already-running sandboxes respond instantly.

5. **MCP is stateless** — CaptiveStyle has no session management. The `StreamableHTTPClientTransport` handles this transparently.
