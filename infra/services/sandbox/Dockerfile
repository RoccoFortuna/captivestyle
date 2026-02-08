FROM node:20-slim

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Pre-bake template node_modules for fast cold starts
WORKDIR /root/template-cache
COPY template-package.json ./package.json
COPY template-package-lock.json ./package-lock.json
RUN npm ci --ignore-scripts

# MCP server
WORKDIR /app/mcp-server
COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci
COPY mcp-server/dist/ ./dist/

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
