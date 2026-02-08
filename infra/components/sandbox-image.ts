import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

export function createArtifactRegistry(projectId: string, region: string) {
  const repo = new gcp.artifactregistry.Repository("sandbox-repo", {
    project: projectId,
    location: region,
    repositoryId: "sandbox",
    format: "DOCKER",
    description: "Container images for sandbox and orchestrator",
  });

  const url = pulumi.interpolate`${region}-docker.pkg.dev/${projectId}/${repo.repositoryId}`;

  return { repo, url };
}
