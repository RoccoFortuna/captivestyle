import * as gcp from "@pulumi/gcp";

export function createSecrets(projectId: string) {
  const apiSecret = new gcp.secretmanager.Secret("api-secret", {
    project: projectId,
    secretId: "orchestrator-api-secret",
    replication: { auto: {} },
  });

  const githubAppPrivateKey = new gcp.secretmanager.Secret(
    "github-app-private-key",
    {
      project: projectId,
      secretId: "github-app-private-key",
      replication: { auto: {} },
    }
  );

  const githubAppId = new gcp.secretmanager.Secret("github-app-id", {
    project: projectId,
    secretId: "github-app-id",
    replication: { auto: {} },
  });

  const githubInstallationId = new gcp.secretmanager.Secret(
    "github-installation-id",
    {
      project: projectId,
      secretId: "github-installation-id",
      replication: { auto: {} },
    }
  );

  return { apiSecret, githubAppPrivateKey, githubAppId, githubInstallationId };
}
