import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

interface CreateRepoOptions {
  description?: string;
  isPrivate?: boolean;
}

export class GitHubClient {
  private appId: string;
  private privateKey: string;
  private installationId: string;
  private org: string;

  constructor(
    appId: string,
    privateKey: string,
    installationId: string,
    org: string
  ) {
    this.appId = appId;
    this.privateKey = privateKey;
    this.installationId = installationId;
    this.org = org;
  }

  private getOctokit(): Octokit {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.appId,
        privateKey: this.privateKey,
        installationId: this.installationId,
      },
    });
  }

  async getInstallationToken(): Promise<string> {
    const auth = createAppAuth({
      appId: this.appId,
      privateKey: this.privateKey,
      installationId: this.installationId,
    });
    const { token } = await auth({ type: "installation" });
    return token;
  }

  /**
   * Create an empty repo in the org. The sandbox entrypoint handles
   * cloning the template and pushing on first boot if the repo is empty.
   */
  async createRepo(repoId: string, options: CreateRepoOptions = {}): Promise<void> {
    const octokit = this.getOctokit();

    await octokit.repos.createInOrg({
      org: this.org,
      name: `sandbox-${repoId}`,
      description: options.description || `Sandbox ${repoId}`,
      private: options.isPrivate !== false,
      auto_init: true,
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    });

    console.log(`Created GitHub repo: ${this.org}/sandbox-${repoId}`);
  }

  async deleteRepo(repoId: string): Promise<void> {
    const octokit = this.getOctokit();

    await octokit.repos.delete({
      owner: this.org,
      repo: `sandbox-${repoId}`,
    });

    console.log(`Deleted GitHub repo: ${this.org}/sandbox-${repoId}`);
  }
}
