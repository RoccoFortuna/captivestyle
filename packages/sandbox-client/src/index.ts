export interface SandboxClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface CreateGitRepositoryOptions {
  name: string;
  public?: boolean;
  source: { url: string; type: "git" };
  devServers?: { preset: string };
}

export interface RequestDevServerOptions {
  repoId: string;
  repoUrl?: string;
}

export interface DevServerResponse {
  ephemeralUrl: string;
  mcpEphemeralUrl: string;
  commitAndPush: (message: string) => Promise<void>;
}

export class SandboxClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: SandboxClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>");
      throw new Error(
        `SandboxClient ${res.status} ${res.statusText}: ${body}`
      );
    }

    return res.json() as Promise<T>;
  }

  async createGitRepository(
    opts: CreateGitRepositoryOptions
  ): Promise<{ repoId: string }> {
    return this.request("/repos", {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }

  async requestDevServer(opts: RequestDevServerOptions): Promise<DevServerResponse> {
    const data = await this.request<{
      ephemeralUrl: string;
      mcpUrl: string;
    }>(`/repos/${opts.repoId}/devserver`, {
      method: "POST",
    });

    return {
      ephemeralUrl: data.ephemeralUrl,
      mcpEphemeralUrl: data.mcpUrl,
      commitAndPush: async (message: string) => {
        await this.request(`/repos/${opts.repoId}/commit`, {
          method: "POST",
          body: JSON.stringify({ message }),
        });
      },
    };
  }
}

export default SandboxClient;
