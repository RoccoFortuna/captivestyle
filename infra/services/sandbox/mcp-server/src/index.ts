import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createProxyMiddleware } from "http-proxy-middleware";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { exec as execCb } from "child_process";
import crypto from "crypto";

const PORT = parseInt(process.env.PORT || "8080", 10);
const WORKSPACE = "/root/workspace";

// --- MCP Server factory ---

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "sandbox-mcp", version: "1.0.0" });

  server.tool(
    "list_directory",
    "List files and directories at the given path",
    { path: z.string().describe("Directory path relative to workspace") },
    async ({ path: dirPath }) => {
      const resolved = path.resolve(WORKSPACE, dirPath);
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const listing = entries
        .map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`)
        .join("\n");
      return { content: [{ type: "text", text: listing }] };
    }
  );

  server.tool(
    "read_file",
    "Read the contents of a file",
    { path: z.string().describe("File path relative to workspace") },
    async ({ path: filePath }) => {
      const resolved = path.resolve(WORKSPACE, filePath);
      const content = await fs.readFile(resolved, "utf-8");
      return { content: [{ type: "text", text: content }] };
    }
  );

  server.tool(
    "write_file",
    "Write content to a file (creates parent directories as needed)",
    {
      path: z.string().describe("File path relative to workspace"),
      content: z.string().describe("File content"),
      encoding: z
        .enum(["utf-8", "base64"])
        .optional()
        .describe("Content encoding, defaults to utf-8"),
    },
    async ({ path: filePath, content, encoding }) => {
      const resolved = path.resolve(WORKSPACE, filePath);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      if (encoding === "base64") {
        await fs.writeFile(resolved, Buffer.from(content, "base64"));
      } else {
        await fs.writeFile(resolved, content, "utf-8");
      }
      return { content: [{ type: "text", text: `Wrote ${resolved}` }] };
    }
  );

  server.tool(
    "exec",
    "Execute a shell command in the workspace",
    { command: z.string().describe("Shell command to execute") },
    async ({ command }) => {
      const result = await new Promise<string>((resolve) => {
        execCb(
          command,
          { cwd: WORKSPACE, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const parts: string[] = [];
            if (stdout) parts.push(stdout);
            if (stderr) parts.push(stderr);
            if (error && !stdout && !stderr)
              parts.push(`[error] ${error.message}`);
            resolve(parts.join("\n") || "(no output)");
          }
        );
      });
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "npm_install",
    "Install npm packages in the workspace",
    {
      packages: z
        .string()
        .describe("Space-separated package names to install"),
    },
    async ({ packages }) => {
      const result = await new Promise<string>((resolve) => {
        execCb(
          `npm install ${packages}`,
          { cwd: WORKSPACE, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const parts: string[] = [];
            if (stdout) parts.push(stdout);
            if (stderr) parts.push(stderr);
            if (error && !stdout && !stderr)
              parts.push(`[error] ${error.message}`);
            resolve(parts.join("\n") || "(no output)");
          }
        );
      });
      return { content: [{ type: "text", text: result }] };
    }
  );

  return server;
}

// --- Transport management (one per MCP session) ---

const transports: Record<string, StreamableHTTPServerTransport> = {};

// --- Express app ---

const app = express();

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// MCP endpoints (StreamableHTTP spec)
app.post("/mcp", express.json(), async (req: Request, res: Response) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && transports[sid]) {
        delete transports[sid];
      }
    };

    await server.connect(transport);

    if (transport.sessionId) {
      transports[transport.sessionId] = transport;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP POST error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// Proxy everything else to Metro (port 3000)
const metroProxy = createProxyMiddleware({
  target: "http://localhost:3000",
  changeOrigin: true,
  ws: true,
});

app.use(metroProxy);

// Start server
const httpServer = app.listen(PORT, () => {
  console.log(`Sandbox MCP server listening on port ${PORT}`);
});

// Proxy WebSocket upgrades for hot reload
httpServer.on("upgrade", (req, socket, head) => {
  metroProxy.upgrade?.(req, socket, head);
});
