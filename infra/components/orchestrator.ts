import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

interface OrchestratorArgs {
  projectId: string;
  region: string;
  serviceAccount: gcp.serviceaccount.Account;
  registryUrl: pulumi.Output<string>;
  secrets: {
    apiSecret: gcp.secretmanager.Secret;
    githubAppPrivateKey: gcp.secretmanager.Secret;
    githubAppId: gcp.secretmanager.Secret;
    githubInstallationId: gcp.secretmanager.Secret;
  };
  githubOrg: string;
}

export function createOrchestrator(args: OrchestratorArgs) {
  const imageUrl = pulumi.interpolate`${args.registryUrl}/orchestrator:latest`;
  const sandboxImageUrl = pulumi.interpolate`${args.registryUrl}/sandbox:latest`;

  const service = new gcp.cloudrunv2.Service("orchestrator", {
    project: args.projectId,
    location: args.region,
    name: "orchestrator",
    template: {
      serviceAccount: args.serviceAccount.email,
      timeout: "600s",
      scaling: {
        minInstanceCount: 0,
        maxInstanceCount: 3,
      },
      containers: [
        {
          image: imageUrl,
          ports: { containerPort: 8080, name: "http1" },
          resources: {
            limits: { cpu: "1", memory: "512Mi" },
          },
          envs: [
            { name: "GCP_PROJECT_ID", value: args.projectId },
            { name: "GCP_REGION", value: args.region },
            { name: "GITHUB_ORG", value: args.githubOrg },
            {
              name: "SANDBOX_IMAGE_URL",
              value: sandboxImageUrl,
            },
            {
              name: "TEMPLATE_REPO_URL",
              value:
                "https://github.com/RoccoFortuna/3d-game-sandbox-template",
            },
            {
              name: "API_SECRET",
              valueSource: {
                secretKeyRef: {
                  secret: args.secrets.apiSecret.secretId,
                  version: "latest",
                },
              },
            },
            {
              name: "GITHUB_APP_ID",
              valueSource: {
                secretKeyRef: {
                  secret: args.secrets.githubAppId.secretId,
                  version: "latest",
                },
              },
            },
            {
              name: "GITHUB_APP_PRIVATE_KEY",
              valueSource: {
                secretKeyRef: {
                  secret: args.secrets.githubAppPrivateKey.secretId,
                  version: "latest",
                },
              },
            },
            {
              name: "GITHUB_INSTALLATION_ID",
              valueSource: {
                secretKeyRef: {
                  secret: args.secrets.githubInstallationId.secretId,
                  version: "latest",
                },
              },
            },
          ],
        },
      ],
    },
  });

  // Allow unauthenticated access (the orchestrator has its own auth middleware)
  new gcp.cloudrunv2.ServiceIamMember("orchestrator-public", {
    project: args.projectId,
    location: args.region,
    name: service.name,
    role: "roles/run.invoker",
    member: "allUsers",
  });

  const url = service.uri;

  return { service, url };
}
