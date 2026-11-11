import { createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Request, RequestHandler } from "express";
import { and, eq, gt } from "drizzle-orm";
import { db, adminSessions } from "@workspace/db";
import { configuredOwnerId } from "./admin-bootstrap";

const scrypt = promisify(nodeScrypt);
export const ADMIN_COOKIE = "__Host-telecart_admin";
export const SESSION_MS = 8 * 3600000;
const authenticated = new WeakMap<Request, string>();

function settings() {
  const email = process.env.TELECART_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.TELECART_ADMIN_INITIAL_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  const owner = configuredOwnerId();
  if (!email || !password || !secret || !owner) return null;
  return { email, password, secret, owner };
}
const digest = (value: string, secret: string) => createHmac("sha256", secret).update(value).digest("hex");
export function credentialVersion() {
  const s = settings();
  return s ? digest(`telecart-admin-credential-v1:${s.email}:${s.owner}:${s.password}`, s.secret) : null;
}
export async function verifyAdminPassword(email: string, password: string) {
  const s = settings();
  if (!s) return false;
  const [expected, supplied] = await Promise.all([
    scrypt(s.password, s.secret, 64), scrypt(password, s.secret, 64),
  ]) as [Buffer, Buffer];
  const passwordMatches = timingSafeEqual(expected, supplied);
  return email.trim().toLowerCase() === s.email && passwordMatches;
}
export async function issueAdminSession() {
  const s = settings();
  const version = credentialVersion();
  if (!s || !version) throw new Error("Admin login not configured.");
  const token = randomBytes(32).toString("hex");
  await db.insert(adminSessions).values({
    tokenHash: digest(token, s.secret), ownerId: s.owner,
    credentialVersion: version, expiresAt: new Date(Date.now() + SESSION_MS),
  });
  return token;
}
export async function revokeAdminSession(token: unknown) {
  const s = settings();
  if (s && typeof token === "string" && /^[a-f0-9]{64}$/.test(token)) {
    await db.delete(adminSessions).where(eq(adminSessions.tokenHash, digest(token, s.secret)));
  }
}
export function getShopAuth(req: Request) {
  return { userId: authenticated.get(req) ?? null };
}
export const adminSessionMiddleware: RequestHandler = async (req, res, next) => {
  try {
    const token = req.cookies?.[ADMIN_COOKIE];
    const s = settings();
    if (s && typeof token === "string" && /^[a-f0-9]{64}$/.test(token)) {
      const [session] = await db.select().from(adminSessions).where(and(
        eq(adminSessions.tokenHash, digest(token, s.secret)),
        eq(adminSessions.ownerId, s.owner),
        eq(adminSessions.credentialVersion, credentialVersion()!),
        gt(adminSessions.expiresAt, new Date()),
      ));
      if (session) authenticated.set(req, session.ownerId);
    }
    next();
  } catch { res.status(503).json({ error: "Unable to verify your admin session. Please try again." }); }
};

export function requireSameOrigin(req: Request) {
  // Browser mutations require an exact configured origin; no forged host/header
  // may select a different trusted origin.
  const origin = req.get("origin");
  const expected = process.env.TELECART_PUBLIC_URL;
  if (!origin || !expected) return false;
  try { return new URL(origin).origin === new URL(expected).origin; }
  catch { return false; }
}
