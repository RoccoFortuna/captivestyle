import { ServicesClient } from "@google-cloud/run";

interface ServiceInfo {
  exists: boolean;
  url: string | null;
}

export class SandboxManager {
  private projectId: string;
  private region: string;
  private sandboxImageUrl: string;
  private client: ServicesClient;

  constructor(projectId: string, region: string, sandboxImageUrl: string) {
    this.projectId = projectId;
    this.region = region;
    this.sandboxImageUrl = sandboxImageUrl;
    this.client = new ServicesClient();
  }

  private parent(): string {
    return `projects/${this.projectId}/locations/${this.region}`;
  }

  private serviceName(repoId: string): string {
    return `${this.parent()}/services/sandbox-${repoId}`;
  }

  async getService(repoId: string): Promise<ServiceInfo> {
    try {
      const [service] = await this.client.getService({
        name: this.serviceName(repoId),
      });
      return { exists: true, url: service.uri || null };
    } catch (error: unknown) {
      if ((error as { code?: number }).code === 5) {
        return { exists: false, url: null };
      }
      throw error;
    }
  }

  async createService(
    repoId: string,
    envVars: Record<string, string>
  ): Promise<{ url: string }> {
    const serviceId = `sandbox-${repoId}`;

    const [operation] = await this.client.createService({
      parent: this.parent(),
      serviceId,
      service: {
        template: {
          scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
          containers: [
            {
              image: this.sandboxImageUrl,
              ports: [{ containerPort: 8080 }],
              env: Object.entries(envVars).map(([name, value]) => ({
                name,
                value,
              })),
              resources: {
                limits: { cpu: "2", memory: "4Gi" },
                cpuIdle: false, // always-on CPU
                startupCpuBoost: true,
              },
              startupProbe: {
                httpGet: { path: "/health", port: 8080 },
                initialDelaySeconds: 10,
                periodSeconds: 5,
                timeoutSeconds: 5,
                failureThreshold: 60, // 10 + 60*5 = 310s max startup time
              },
            },
          ],
        },
      },
    });

    const [service] = await operation.promise();
    const url = service.uri;
    if (!url) throw new Error(`No URI returned for ${serviceId}`);

    // Allow unauthenticated access for preview URLs
    await this.client.setIamPolicy({
      resource: `${this.parent()}/services/${serviceId}`,
      policy: {
        bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }],
      },
    });

    console.log(`Created sandbox ${serviceId} at ${url}`);
    return { url };
  }

  async deleteService(repoId: string): Promise<void> {
    const [operation] = await this.client.deleteService({
      name: this.serviceName(repoId),
    });
    await operation.promise();
    console.log(`Deleted sandbox sandbox-${repoId}`);
  }

  async waitForReady(url: string, timeoutMs = 120_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          console.log(`Sandbox at ${url} is ready`);
          return;
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`Sandbox at ${url} not ready after ${timeoutMs}ms`);
  }
}
