import { Router, Request, Response } from "express";
import { customAlphabet } from "nanoid";
import { GitHubClient } from "../lib/github-client";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

export const reposRouter = Router();

function getGitHubClient(): GitHubClient {
  const appId = process.env.GITHUB_APP_ID!;
  const privateKey = Buffer.from(
    process.env.GITHUB_APP_PRIVATE_KEY!,
    "base64"
  ).toString("utf-8");
  const installationId = process.env.GITHUB_INSTALLATION_ID!;
  const org = process.env.GITHUB_ORG!;

  return new GitHubClient(appId, privateKey, installationId, org);
}

reposRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const repoId = nanoid();
    const client = getGitHubClient();

    await client.createRepo(repoId, {
      description: `Sandbox: ${name}`,
      isPrivate: !req.body.public,
    });

    console.log(`Created repo sandbox-${repoId}`);
    res.status(201).json({ repoId });
  } catch (error) {
    console.error("Error creating repo:", error);
    res.status(500).json({ error: "Failed to create repo" });
  }
});
