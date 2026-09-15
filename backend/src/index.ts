import path from "node:path";
import express from "express";
import { config } from "./config.js";
import { getDb } from "./db/database.js";
import { frameRouter } from "./api/frame.js";
import { adminRouter } from "./api/admin.js";
import { albumSourcesRouter } from "./api/album-sources.js";
import { authRouter } from "./api/auth.js";
import { requireWebAuth } from "./api/middleware.js";
import { startSyncScheduler } from "./services/sync-scheduler.js";

const app = express();

// Trust reverse proxy (Cloudflare Tunnel, Nginx) for accurate client IP detection —
// only when explicitly configured via TRUST_PROXY, since client-supplied
// X-Forwarded-For/CF-Connecting-IP headers must not be trusted otherwise.
app.set("trust proxy", config.trustProxy ? 1 : false);

// Disable Express identifier to prevent framework fingerprinting
app.disable("x-powered-by");

// Parse JSON payloads
app.use(express.json());

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Enable CORS for web emulator and cross-origin frame clients
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Frame-ID, X-Battery-Voltage, X-Firmware-Version, X-Frame-Orientation"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Sleep-Seconds, X-Frame-Mode, X-Image-ID, Content-Length, X-Frame-Orientation"
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Health check endpoint for reverse proxy / docker healthcheck
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Mount Public Auth Router (login, logout, check)
app.use("/api/v1/auth", authRouter);

// Mount Frame IoT Router (authenticated via frame token)
app.use("/api/v1/frame", frameRouter);

// Mount Admin API Router (authenticated via session/token)
app.use("/api/v1/admin", adminRouter);

// Mount Album Sources / per-frame settings Router (Phase 2+3 of the multi-frame
// architecture) - a separate router from adminRouter, but on the same path prefix and
// with the same session-auth middleware applied internally.
app.use("/api/v1/admin", albumSourcesRouter);

const publicDir = path.resolve(process.cwd(), "src", "public");

// Public login page
app.get("/login.html", (req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
});

// Protected web interface routes
app.get(["/", "/index.html"], requireWebAuth, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/emulator.html", requireWebAuth, (req, res) => {
  res.sendFile(path.join(publicDir, "emulator.html"));
});

// Static assets (CSS/images/favicons) fallback
app.use(express.static(publicDir));

// Initialize database & start background workers
try {
  getDb();
  console.log(`[DB] SQLite database initialized at ${config.dbPath}`);

  startSyncScheduler();
  console.log("[SCHEDULER] Album sync background scheduler started.");

  app.listen(config.port, "0.0.0.0", () => {
    console.log(`=======================================================`);
    console.log(` Cuadro Backend running on port ${config.port}`);
    console.log(` Frame Endpoint: http://localhost:${config.port}/api/v1/frame/next`);
    console.log(` Admin Web UI:   http://localhost:${config.port}/`);
    console.log(`=======================================================`);
  });
} catch (err) {
  console.error("[FATAL] Failed to start Cuadro backend:", err);
  process.exit(1);
}
