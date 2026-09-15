import crypto from "node:crypto";
import { Request, Response, Router } from "express";
import { config } from "../config.js";
import { getDb } from "../db/database.js";

export const authRouter = Router();

// Constant-time string comparison using SHA-256 to prevent timing attacks
export function timingSafeCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// In-memory rate limiting against brute force login attempts
interface RateLimitRecord {
  attempts: number;
  firstAttempt: number;
  blockedUntil: number;
}

const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const rateLimitMap = new Map<string, RateLimitRecord>();

// Client-supplied headers like CF-Connecting-IP / X-Forwarded-For are
// attacker-controlled unless a trusted reverse proxy in front of this app is
// confirmed to set (and overwrite) them. Rely solely on Express's own
// trust-proxy-aware req.ip, which only honors X-Forwarded-For (one hop) when
// "trust proxy" is explicitly enabled via TRUST_PROXY, and otherwise falls
// back to the actual socket address — preventing rate-limit bypass via
// spoofed headers.
function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function checkRateLimit(ip: string): { blocked: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record) return { blocked: false };

  if (record.blockedUntil > now) {
    const retryAfterSeconds = Math.ceil((record.blockedUntil - now) / 1000);
    return { blocked: true, retryAfterSeconds };
  }

  // Reset if outside attempt window and not blocked
  if (now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
    rateLimitMap.delete(ip);
    return { blocked: false };
  }

  return { blocked: false };
}

export function recordFailedAttempt(ip: string): { blocked: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  let record = rateLimitMap.get(ip);

  if (!record || now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
    record = { attempts: 1, firstAttempt: now, blockedUntil: 0 };
    rateLimitMap.set(ip, record);
    return { blocked: false };
  }

  record.attempts += 1;
  if (record.attempts >= MAX_FAILED_ATTEMPTS) {
    record.blockedUntil = now + BLOCK_DURATION_MS;
    const retryAfterSeconds = Math.ceil(BLOCK_DURATION_MS / 1000);
    return { blocked: true, retryAfterSeconds };
  }

  return { blocked: false };
}

export function clearFailedAttempts(ip: string): void {
  rateLimitMap.delete(ip);
}

// Session Management with SQLite persistence
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createSession(ip: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const expiresAt = now + SESSION_LIFETIME_MS;

  const db = getDb();
  db.prepare(`
    INSERT INTO sessions (token, created_at, expires_at, ip)
    VALUES (?, ?, ?, ?)
  `).run(token, now, expiresAt, ip);

  return token;
}

export function validateSession(token: string): boolean {
  if (!token || typeof token !== "string" || token.length < 32) return false;

  const db = getDb();
  const now = Date.now();
  const session = db
    .prepare("SELECT expires_at FROM sessions WHERE token = ?")
    .get(token) as { expires_at: number } | undefined;

  if (!session) return false;

  if (session.expires_at < now) {
    // Expired session
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return false;
  }

  return true;
}

export function revokeSession(token: string): void {
  if (!token) return;
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// Builds the Set-Cookie header value for the session cookie. Includes the
// Secure attribute whenever the request is actually served over HTTPS
// (req.secure correctly reflects X-Forwarded-Proto once "trust proxy" is
// enabled per TRUST_PROXY, and reflects the real TLS state otherwise), so the
// session token is never sent in cleartext over a plain-HTTP deployment.
export function buildSessionCookie(req: Request, token: string, maxAgeSeconds: number): string {
  const secureAttr = req.secure ? "; Secure" : "";
  return `memories_session=${token}; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Max-Age=${maxAgeSeconds}`;
}

// Cookie parser helper
export function parseCookies(cookieHeader?: string): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  for (const item of cookieHeader.split(";")) {
    const parts = item.split("=");
    const key = parts[0]?.trim();
    if (key) {
      list[key] = decodeURIComponent((parts[1] || "").trim());
    }
  }
  return list;
}

/**
 * POST /api/v1/auth/login
 */
authRouter.post("/login", (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const rateLimit = checkRateLimit(ip);

  if (rateLimit.blocked) {
    res.status(429).json({
      error: `Too many failed login attempts. Please wait ${rateLimit.retryAfterSeconds} seconds before trying again.`,
      retryAfterSeconds: rateLimit.retryAfterSeconds
    });
    return;
  }

  const { password } = req.body || {};
  if (!password || !timingSafeCompare(password, config.adminPassword)) {
    const failure = recordFailedAttempt(ip);
    if (failure.blocked) {
      res.status(429).json({
        error: `Too many failed login attempts. IP temporarily locked out for 15 minutes.`,
        retryAfterSeconds: failure.retryAfterSeconds
      });
    } else {
      res.status(401).json({ error: "Invalid admin password" });
    }
    return;
  }

  // Password matches! Clear failed attempts and create session
  clearFailedAttempts(ip);
  const sessionToken = createSession(ip);

  // Set HTTP-only, SameSite=Lax cookie (Secure added when the request is HTTPS)
  res.setHeader(
    "Set-Cookie",
    buildSessionCookie(req, sessionToken, Math.round(SESSION_LIFETIME_MS / 1000))
  );

  res.json({
    status: "success",
    token: sessionToken,
    message: "Authenticated successfully"
  });
});

/**
 * POST /api/v1/auth/logout
 */
authRouter.post("/logout", (req: Request, res: Response) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.memories_session || (req.headers.authorization?.slice(7).trim());
  if (sessionToken) {
    revokeSession(sessionToken);
  }

  res.setHeader("Set-Cookie", buildSessionCookie(req, "", 0));
  res.json({ status: "success", message: "Logged out" });
});

/**
 * GET /api/v1/auth/check
 */
authRouter.get("/check", (req: Request, res: Response) => {
  const cookies = parseCookies(req.headers.cookie);
  const authHeader = req.headers.authorization;
  const token =
    cookies.memories_session ||
    (authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined) ||
    (req.query.token as string | undefined);

  if (token && (validateSession(token) || timingSafeCompare(token, config.adminPassword))) {
    res.json({ authenticated: true });
    return;
  }

  res.status(401).json({ authenticated: false });
});
