import { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { timingSafeCompare, validateSession, parseCookies } from "./auth.js";

/**
 * Middleware ensuring frame API requests have a valid Bearer token.
 * Uses timing-safe constant-time string comparison against attacks.
 */
export function requireFrameAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!timingSafeCompare(token, config.frameToken)) {
    res.status(403).json({ error: "Forbidden: invalid frame token" });
    return;
  }

  next();
}

/**
 * Middleware ensuring admin API requests have a valid session or admin password.
 * Checks session cookie, Authorization Bearer token, or query parameter.
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  // 1. Check HTTP-only session cookie
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.memories_session;
  if (sessionToken && validateSession(sessionToken)) {
    next();
    return;
  }

  // 2. Check Authorization: Bearer <sessionToken_or_adminPassword>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (validateSession(token) || timingSafeCompare(token, config.adminPassword)) {
      next();
      return;
    }
  }

  // 3. Query token fallback
  const queryToken = req.query.token as string | undefined;
  if (queryToken && (validateSession(queryToken) || timingSafeCompare(queryToken, config.adminPassword))) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized: valid admin session or password required" });
}

/**
 * Middleware for web routes (HTML).
 * If user does not have a valid session, redirects to /login.html.
 */
export function requireWebAuth(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.memories_session;
  if (sessionToken && validateSession(sessionToken)) {
    next();
    return;
  }

  // Also check query param or bearer
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (validateSession(token) || timingSafeCompare(token, config.adminPassword)) {
      next();
      return;
    }
  }

  const queryToken = req.query.token as string | undefined;
  if (queryToken && (validateSession(queryToken) || timingSafeCompare(queryToken, config.adminPassword))) {
    next();
    return;
  }

  // Redirect unauthenticated web browser requests to login page
  res.redirect(`/login.html?redirect=${encodeURIComponent(req.originalUrl || "/")}`);
}
