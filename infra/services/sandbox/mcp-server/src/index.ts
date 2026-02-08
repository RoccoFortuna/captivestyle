import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createProxyMiddleware } from "http-proxy-middleware";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { exec as execCb } from "child_process";
const PORT = parseInt(process.env.PORT || "8080", 10);
const WORKSPACE = "/root/workspace";

// --- MCP Server factory ---

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "sandbox-mcp", version: "1.0.0" });

  const listDirSchema = z.object({ path: z.string() });
  server.registerTool("list_directory", {
    description: "List files and directories at the given path",
    inputSchema: listDirSchema,
  }, async ({ path: dirPath }) => {
    const resolved = path.resolve(WORKSPACE, dirPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const listing = entries
      .map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`)
      .join("\n");
    return { content: [{ type: "text", text: listing }] };
  });

  const readFileSchema = z.object({ path: z.string() });
  server.registerTool("read_file", {
    description: "Read the contents of a file",
    inputSchema: readFileSchema,
  }, async ({ path: filePath }) => {
    const resolved = path.resolve(WORKSPACE, filePath);
    const content = await fs.readFile(resolved, "utf-8");
    return { content: [{ type: "text", text: content }] };
  });

  const writeFileSchema = z.object({
    path: z.string(),
    content: z.string(),
    encoding: z.enum(["utf-8", "base64"]).optional(),
  });
  server.registerTool("write_file", {
    description: "Write content to a file (creates parent directories as needed)",
    inputSchema: writeFileSchema,
  }, async ({ path: filePath, content, encoding }) => {
    const resolved = path.resolve(WORKSPACE, filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    if (encoding === "base64") {
      await fs.writeFile(resolved, Buffer.from(content, "base64"));
    } else {
      await fs.writeFile(resolved, content, "utf-8");
    }
    return { content: [{ type: "text", text: `Wrote ${resolved}` }] };
  });

  const execSchema = z.object({ command: z.string() });
  server.registerTool("exec", {
    description: "Execute a shell command in the workspace",
    inputSchema: execSchema,
  }, async ({ command }) => {
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
  });

  const npmInstallSchema = z.object({ packages: z.string() });
  server.registerTool("npm_install", {
    description: "Install npm packages in the workspace",
    inputSchema: npmInstallSchema,
  }, async ({ packages }) => {
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
  });

  return server;
}

// --- Express app ---

const app = express();

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// MCP endpoints — stateless mode: each request gets a fresh server+transport.
// This avoids session affinity issues on Cloud Run.
app.post("/mcp", express.json(), async (req: Request, res: Response) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP POST error:", err);
    if (!res.headersSent) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  }
});

app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "SSE not supported in stateless mode" });
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Session deletion not supported in stateless mode" });
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
  metroProxy.upgrade?.(req, socket as any, head);
});
