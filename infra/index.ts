import * as pulumi from "@pulumi/pulumi";
import { createArtifactRegistry } from "./components/sandbox-image";
import { createOrchestrator } from "./components/orchestrator";
import { createIam } from "./components/iam";
import { createSecrets } from "./components/secrets";

const config = new pulumi.Config();
const gcpConfig = new pulumi.Config("gcp");

const projectId = gcpConfig.require("project");
const region = gcpConfig.require("region");
const githubOrg = config.require("githubOrg");

// 1. Artifact Registry for container images
const registry = createArtifactRegistry(projectId, region);

// 2. IAM service accounts
const { orchestratorSa, sandboxSa } = createIam(projectId);

// 3. Secrets
const secrets = createSecrets(projectId);

// 4. Orchestrator Cloud Run service
const orchestrator = createOrchestrator({
  projectId,
  region,
  serviceAccount: orchestratorSa,
  registryUrl: registry.url,
  secrets,
  githubOrg,
});

// Exports
export const orchestratorUrl = orchestrator.url;
export const registryUrl = registry.url;
export const orchestratorServiceAccount = orchestratorSa.email;
export const sandboxServiceAccount = sandboxSa.email;
