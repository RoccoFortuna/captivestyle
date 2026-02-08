import { Router, Request, Response } from "express";
import { SandboxManager } from "../lib/sandbox-manager";
import { GitHubClient } from "../lib/github-client";

export const devserversRouter = Router();

function getSandboxManager(): SandboxManager {
  return new SandboxManager(
    process.env.GCP_PROJECT_ID!,
    process.env.GCP_REGION || "us-central1",
    process.env.SANDBOX_IMAGE_URL!
  );
}

function getGitHubClient(): GitHubClient {
  const privateKey = Buffer.from(
    process.env.GITHUB_APP_PRIVATE_KEY!,
    "base64"
  ).toString("utf-8");
  return new GitHubClient(
    process.env.GITHUB_APP_ID!,
    privateKey,
    process.env.GITHUB_INSTALLATION_ID!,
    process.env.GITHUB_ORG!
  );
}

// POST /repos/:repoId/devserver
devserversRouter.post(
  "/:repoId/devserver",
  async (req: Request, res: Response) => {
    try {
      const { repoId } = req.params;

      if (!req.body?.templateRepoUrl) {
        res.status(400).json({ error: "templateRepoUrl is required" });
        return;
      }

      const manager = getSandboxManager();

      // Check if sandbox already exists
      const existing = await manager.getService(repoId);
      if (existing.exists && existing.url) {
        console.log(`Sandbox sandbox-${repoId} already exists`);
        res.json({
          ephemeralUrl: existing.url,
          mcpUrl: `${existing.url}/mcp`,
        });
        return;
      }

      // Create new sandbox
      const githubClient = getGitHubClient();
      const gitToken = await githubClient.getInstallationToken();

      const result = await manager.createService(repoId, {
        REPO_ID: repoId,
        GIT_TOKEN: gitToken,
        GITHUB_ORG: process.env.GITHUB_ORG!,
        TEMPLATE_REPO_URL: req.body.templateRepoUrl,
        PRESET: req.body?.preset || "expo",
      });

      // Wait for healthy
      console.log(`Waiting for sandbox-${repoId} to become ready...`);
      await manager.waitForReady(result.url, 120_000);

      res.status(201).json({
        ephemeralUrl: result.url,
        mcpUrl: `${result.url}/mcp`,
      });
    } catch (error) {
      console.error("Error creating devserver:", error);
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to create devserver: ${message}` });
    }
  }
);

// POST /repos/:repoId/commit
devserversRouter.post(
  "/:repoId/commit",
  async (req: Request, res: Response) => {
    try {
      const { repoId } = req.params;
      const { message } = req.body;

      if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
      }

      const manager = getSandboxManager();
      const existing = await manager.getService(repoId);

      if (!existing.exists || !existing.url) {
        res.status(404).json({ error: "Sandbox not running" });
        return;
      }

      // Call sandbox MCP exec to run git commit + push
      const escapedMsg = message.replace(/"/g, '\\"');
      const mcpResponse = await fetch(`${existing.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "exec",
            arguments: {
              command: `cd /root/workspace && git add -A && git commit -m "${escapedMsg}" && git push origin main`,
            },
          },
        }),
      });

      if (!mcpResponse.ok) {
        throw new Error(`MCP call failed: ${mcpResponse.status}`);
      }

      res.json({ success: true, message: `Committed: ${message}` });
    } catch (error) {
      console.error("Error committing:", error);
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to commit: ${message}` });
    }
  }
);

// GET /repos/:repoId/status
devserversRouter.get(
  "/:repoId/status",
  async (req: Request, res: Response) => {
    try {
      const { repoId } = req.params;
      const manager = getSandboxManager();
      const existing = await manager.getService(repoId);

      if (!existing.exists) {
        res.json({ status: "not_found" });
        return;
      }

      try {
        const health = await fetch(`${existing.url}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        res.json({ status: health.ok ? "running" : "stopped" });
      } catch {
        res.json({ status: "stopped" });
      }
    } catch (error) {
      console.error("Error getting status:", error);
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to get status: ${message}` });
    }
  }
);
