import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import { desc, eq, and } from "drizzle-orm";
import { db, botConnections, shopPayments, botCustomers } from "@workspace/db";
import { GetIntegrationResponse, ConnectIntegrationBody, CheckPaymentAttemptParams, ListPaymentAttemptsResponse, CheckPaymentAttemptResponse } from "@workspace/api-zod";
import { integrationStatus, requireOperator, activeConnection } from "../lib/commerce-connection";
import { CommerceError, nowpayments, telegram, publicBaseUrl, webhookSecret } from "../lib/commerce-providers";
import { checkPayment } from "../lib/commerce-payments";

const router: IRouter = Router();
export async function paymentAttempts(ownerId: string | null) {
  if (!ownerId) return [];
  const rows = await db.select({ payment: shopPayments, customer: botCustomers.username }).from(shopPayments)
    .innerJoin(botCustomers, eq(botCustomers.id, shopPayments.customerId)).where(eq(shopPayments.ownerId, ownerId)).orderBy(desc(shopPayments.createdAt)).limit(200);
  return rows.map(({ payment: p, customer }) => ({
    id: p.id, kind: p.kind, customer, productName: p.productName, amount: p.amountCents / 100,
    currency: p.coin.toUpperCase(), status: p.status, fulfillment: p.fulfillment,
    providerPaymentId: p.providerPaymentId, createdAt: p.createdAt.toISOString(),
  }));
}
router.get("/integration", async (req, res): Promise<void> => {
  res.json(GetIntegrationResponse.parse(await integrationStatus(getAuth(req).userId)));
});
router.post("/integration/connect", async (req, res): Promise<void> => {
  const ownerId = getAuth(req).userId;
  requireOperator(ownerId);
  if (process.env.NODE_ENV !== "production") throw new CommerceError("Activate the live webhook from the published admin panel, not the development preview.", 409);
  const parsed = ConnectIntegrationBody.safeParse(req.body);
  if (!parsed.success || parsed.data.acknowledgePolicy !== true) throw new CommerceError("Acknowledge the provider and Telegram rules before activation.");
  const baseUrl = publicBaseUrl();
  if (!baseUrl) throw new CommerceError("Publish first, then configure TELECART_PUBLIC_URL with the verified public production origin.");
  if (!process.env.NOWPAYMENTS_IPN_SECRET) throw new CommerceError("NOWPayments IPN secret is missing.");
  const [me] = await Promise.all([
    telegram<{ id: number; username: string }>("getMe"),
    nowpayments<{ currencies: string[] }>("/currencies"),
  ]);
  const [existing] = await db.select().from(botConnections).where(eq(botConnections.id, "primary"));
  if (existing?.ownerId && existing.ownerId !== ownerId) throw new CommerceError("This bot is bound to another shop.", 409);
  if (existing && existing.botId !== String(me.id)) throw new CommerceError("The token belongs to a different bot. Existing buyers and payments require an explicit migration.", 409);
  // No pending updates are dropped by setup/reconnect.
  await telegram("setWebhook", { url: `${baseUrl}/api/telegram/webhook`, secret_token: webhookSecret(), allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
  await db.insert(botConnections).values({
    id: "primary", ownerId: ownerId!, botId: String(me.id), botUsername: me.username, publicUrl: baseUrl, active: "yes",
  }).onConflictDoUpdate({ target: botConnections.id, set: {
    ownerId: ownerId!, botId: String(me.id), botUsername: me.username, publicUrl: baseUrl, active: "yes", verifiedAt: new Date(),
  } });
  res.json(GetIntegrationResponse.parse(await integrationStatus(ownerId)));
});
router.post("/integration/disconnect", async (req, res): Promise<void> => {
  requireOperator(getAuth(req).userId);
  await telegram("deleteWebhook", { drop_pending_updates: false });
  await db.update(botConnections).set({ active: "no" }).where(eq(botConnections.id, "primary"));
  res.sendStatus(204);
});
router.get("/payment-attempts", async (req, res): Promise<void> => {
  res.json(ListPaymentAttemptsResponse.parse(await paymentAttempts(getAuth(req).userId)));
});
router.post("/payment-attempts/:id/check", async (req, res): Promise<void> => {
  const ownerId = getAuth(req).userId;
  requireOperator(ownerId);
  const params = CheckPaymentAttemptParams.safeParse(req.params);
  if (!params.success) throw new CommerceError("Invalid payment reference.");
  const [payment] = await db.select().from(shopPayments).where(and(eq(shopPayments.id, params.data.id), eq(shopPayments.ownerId, ownerId!)));
  if (!payment) throw new CommerceError("Payment not found.", 404);
  await checkPayment(payment.id);
  res.json(CheckPaymentAttemptResponse.parse((await paymentAttempts(ownerId)).find(p => p.id === payment.id)));
});
export default router;
