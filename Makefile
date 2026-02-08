include .env
export

REGISTRY = $(GCP_REGION)-docker.pkg.dev/$(GCP_PROJECT_ID)/sandbox
PLATFORM = linux/amd64

# --- Build & Push ---

.PHONY: build-orchestrator push-orchestrator build-sandbox push-sandbox

build-orchestrator:
	cd infra/services/orchestrator && npm install && npx tsc
	docker buildx build --platform $(PLATFORM) \
		-t $(REGISTRY)/orchestrator:latest \
		--push infra/services/orchestrator

build-sandbox:
	cd infra/services/sandbox/mcp-server && npm install && npx tsc
	docker buildx build --platform $(PLATFORM) \
		-t $(REGISTRY)/sandbox:latest \
		--push infra/services/sandbox

build-all: build-orchestrator build-sandbox

# --- Deploy ---

.PHONY: deploy

deploy:
	cd infra && pulumi up --yes

# --- Secrets ---

.PHONY: secrets

secrets:
	@echo "Populating secrets in Secret Manager..."
	echo -n "$(GITHUB_APP_ID)" | gcloud secrets versions add github-app-id --data-file=-
	echo -n "$(GITHUB_APP_PRIVATE_KEY)" | gcloud secrets versions add github-app-private-key --data-file=-
	echo -n "$(GITHUB_INSTALLATION_ID)" | gcloud secrets versions add github-installation-id --data-file=-
	echo -n "$(API_SECRET)" | gcloud secrets versions add orchestrator-api-secret --data-file=-

# --- GitHub token ---

.PHONY: github-token

github-token:
	@echo "$(GITHUB_APP_PRIVATE_KEY)" | base64 -d > /tmp/_gh_app_key.pem
	@npx github-app-installation-token \
		--appId $(GITHUB_APP_ID) \
		--installationId $(GITHUB_INSTALLATION_ID) \
		--privateKeyLocation /tmp/_gh_app_key.pem
	@rm /tmp/_gh_app_key.pem

# --- Full rebuild & deploy ---

.PHONY: ship

ship: build-all deploy
