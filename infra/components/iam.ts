import * as gcp from "@pulumi/gcp";

export function createIam(projectId: string) {
  // Orchestrator service account — manages Cloud Run services + GitHub
  const orchestratorSa = new gcp.serviceaccount.Account("orchestrator-sa", {
    project: projectId,
    accountId: "orchestrator",
    displayName: "Sandbox Orchestrator",
  });

  // Cloud Run Admin — create/delete sandbox services + set IAM policies
  new gcp.projects.IAMMember("orchestrator-run-admin", {
    project: projectId,
    role: "roles/run.admin",
    member: orchestratorSa.email.apply((e) => `serviceAccount:${e}`),
  });

  // Artifact Registry Reader — pull sandbox images
  new gcp.projects.IAMMember("orchestrator-ar-reader", {
    project: projectId,
    role: "roles/artifactregistry.reader",
    member: orchestratorSa.email.apply((e) => `serviceAccount:${e}`),
  });

  // Service Account User — assign sandbox SA to sandbox services
  new gcp.projects.IAMMember("orchestrator-sa-user", {
    project: projectId,
    role: "roles/iam.serviceAccountUser",
    member: orchestratorSa.email.apply((e) => `serviceAccount:${e}`),
  });

  // Secret Manager Accessor — read secrets
  new gcp.projects.IAMMember("orchestrator-secret-accessor", {
    project: projectId,
    role: "roles/secretmanager.secretAccessor",
    member: orchestratorSa.email.apply((e) => `serviceAccount:${e}`),
  });

  // Sandbox service account — minimal permissions
  const sandboxSa = new gcp.serviceaccount.Account("sandbox-sa", {
    project: projectId,
    accountId: "sandbox",
    displayName: "Sandbox Container",
  });

  return { orchestratorSa, sandboxSa };
}
