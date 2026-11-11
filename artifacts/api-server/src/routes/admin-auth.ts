import { Router, type IRouter } from "express";
import { eq, lt, sql } from "drizzle-orm";
import { db, adminLoginLimits, adminSessions } from "@workspace/db";
import { LoginAdminBody, GetAdminSessionResponse, LoginAdminResponse } from "@workspace/api-zod";
import { adminCookieName, adminCookieOptions, SESSION_MS, getShopAuth, issueAdminSession, requireSameOrigin, revokeAdminSession, verifyAdminPassword } from "../lib/admin-auth";
import { configuredOwnerId } from "../lib/admin-bootstrap";

const router: IRouter = Router();
// The dashboard runs inside Replit's cross-site preview iframe. Partitioned
// cookies support that embedding; exact Origin checks protect every mutation.
router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
router.get("/admin/session", (req, res): void => {
  const owner = getShopAuth(req).userId;
  res.json(GetAdminSessionResponse.parse({ signedIn: Boolean(owner), ownerId: owner, email: owner ? process.env.TELECART_ADMIN_EMAIL ?? null : null }));
});
router.post("/admin/login", async (req, res): Promise<void> => {
  if (!requireSameOrigin(req)) { res.status(403).json({ error: "Cross-origin sign-in is not permitted." }); return; }
  const parsed = LoginAdminBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Enter your admin email and password." }); return; }
  // Shared database limit applies across server replicas; the bucket contains
  // no submitted identifiers, passwords or client IP addresses.
  const bucket = `admin-login:${process.env.NODE_ENV === "production" ? "production" : "development"}:${configuredOwnerId() ?? "unconfigured"}`;
  const now = new Date();
  const [limit] = await db.insert(adminLoginLimits).values({ bucket, attempts: 1, resetAt: new Date(Date.now() + 15 * 60000) })
    .onConflictDoUpdate({ target: adminLoginLimits.bucket, set: {
      attempts: sql`CASE WHEN ${adminLoginLimits.resetAt} < ${now} THEN 1 ELSE ${adminLoginLimits.attempts} + 1 END`,
      resetAt: sql`CASE WHEN ${adminLoginLimits.resetAt} < ${now} THEN ${new Date(Date.now() + 15 * 60000)} ELSE ${adminLoginLimits.resetAt} END`,
    } }).returning();
  if (!limit || limit.attempts > 10) { res.status(429).json({ error: "Too many sign-in attempts. Wait 15 minutes and try again." }); return; }
  if (!await verifyAdminPassword(parsed.data.email, parsed.data.password)) {
    res.status(401).json({ error: "Incorrect admin email or password." }); return;
  }
  await revokeAdminSession(req.cookies?.[adminCookieName()]);
  const token = await issueAdminSession();
  await db.delete(adminLoginLimits).where(eq(adminLoginLimits.bucket, bucket));
  await db.delete(adminSessions).where(lt(adminSessions.expiresAt, now));
  res.cookie(adminCookieName(), token, { ...adminCookieOptions(), maxAge: SESSION_MS });
  res.json(LoginAdminResponse.parse({ signedIn: true, ownerId: configuredOwnerId(), email: process.env.TELECART_ADMIN_EMAIL }));
});
router.post("/admin/logout", async (req, res): Promise<void> => {
  if (!requireSameOrigin(req)) { res.status(403).json({ error: "Cross-origin sign-out is not permitted." }); return; }
  await revokeAdminSession(req.cookies?.[adminCookieName()]);
  res.clearCookie(adminCookieName(), adminCookieOptions());
  res.sendStatus(204);
});
export default router;
