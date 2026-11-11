import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import { desc, eq, and } from "drizzle-orm";
import { db, botConnections, shopPayments, botCustomers } from "@workspace/db";
import { GetIntegrationResponse, ConnectIntegrationBody, CheckPaymentAttemptParams, ListPaymentAttemptsResponse, CheckPaymentAttemptResponse } from "@workspace/api-zod";
import { integrationStatus, requireOperator, activeConnection } from "../lib/commerce-connection";
import { CommerceError, telegram } from "../lib/commerce-providers";
import { connectShop } from "../lib/connect-shop";
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
  const parsed = ConnectIntegrationBody.safeParse(req.body);
  if (!parsed.success || parsed.data.acknowledgePolicy !== true) throw new CommerceError("Acknowledge the provider and Telegram rules before activation.");
  await connectShop(ownerId!);
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
