import express, { Request, Response, NextFunction } from "express";
import { reposRouter } from "./routes/repos";
import { devserversRouter } from "./routes/devservers";

const app = express();
const PORT = parseInt(process.env.PORT || "8080", 10);

app.use(express.json());

// Auth middleware
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health") {
    next();
    return;
  }

  const apiSecret = process.env.API_SECRET;
  if (!apiSecret) {
    console.error("API_SECRET not set");
    res.status(500).json({ error: "Server misconfigured" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  if (authHeader.slice(7) !== apiSecret) {
    res.status(403).json({ error: "Invalid API secret" });
    return;
  }

  next();
}

app.use(authMiddleware);

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.use("/repos", reposRouter);
app.use("/repos", devserversRouter);

app.listen(PORT, () => {
  console.log(`Orchestrator API listening on port ${PORT}`);
});

export default app;
