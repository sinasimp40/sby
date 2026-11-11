import { Router, type IRouter } from "express";
import { getShopAuth as getAuth } from "../lib/admin-auth";
import { desc, eq, and } from "drizzle-orm";
import { db, botConnections, shopPayments, botCustomers } from "@workspace/db";
import { GetIntegrationResponse, GetPaymentMinimumsResponse, ConnectIntegrationBody, CheckPaymentAttemptParams, ListPaymentAttemptsResponse, CheckPaymentAttemptResponse } from "@workspace/api-zod";
import { integrationStatus, requireOperator, activeConnection } from "../lib/commerce-connection";
import { CommerceError, checkNOWPaymentsKey, checkTelegramToken } from "../lib/commerce-providers";
import { checkPayment } from "../lib/commerce-payments";
import { paymentMinimums } from "../lib/payment-minimums";
import { saveNowpaymentsCredentials, saveTelegramCredential } from "../lib/provider-credentials";
import { SaveTelegramCredentialBody, SaveNowpaymentsCredentialsBody } from "@workspace/api-zod";
import { UpdateTelegramRuntimeBody } from "@workspace/api-zod";
import { updateBotRuntime } from "../lib/bot-runtime-control";
import { getBotRuntime } from "../lib/bot-runtime";

const router: IRouter = Router();
export async function paymentAttempts(ownerId: string | null) {
  if (!ownerId) return [];
  const rows = await db.select({ payment: shopPayments, customer: botCustomers.username }).from(shopPayments)
    .innerJoin(botCustomers, eq(botCustomers.id, shopPayments.customerId)).where(eq(shopPayments.ownerId, ownerId)).orderBy(desc(shopPayments.createdAt)).limit(200);
  return rows.map(({ payment: p, customer }) => ({
    id: p.id, kind: p.kind, customer, productName: p.productName, amount: p.amountCents / 100,
    currency: p.coin.toUpperCase(), status: p.status, fulfillment: p.fulfillment,
    cancelledAt: p.cancelledAt?.toISOString() ?? null,
    providerPaymentId: p.providerPaymentId, createdAt: p.createdAt.toISOString(),
    payAmount: p.payAmount, receivedAmount: p.receivedAmount, lastCheckedAt: p.lastCheckedAt?.toISOString() ?? null,
  }));
}
router.get("/integration", async (req, res): Promise<void> => {
  res.json(GetIntegrationResponse.parse(await integrationStatus(getAuth(req).userId)));
});
router.get("/payment-minimums", async (req, res): Promise<void> => {
  requireOperator(getAuth(req).userId);
  res.json(GetPaymentMinimumsResponse.parse(await paymentMinimums()));
});
router.post("/integration/connect", async (req, res): Promise<void> => {
  const ownerId = getAuth(req).userId;
  requireOperator(ownerId);
  const parsed = ConnectIntegrationBody.safeParse(req.body);
  if (!parsed.success || parsed.data.acknowledgePolicy !== true) throw new CommerceError("Acknowledge the provider and Telegram rules before activation.");
  await updateBotRuntime(ownerId!, { ...await getBotRuntime(ownerId!), enabled: true }, true);
  res.json(GetIntegrationResponse.parse(await integrationStatus(ownerId)));
});
router.post("/integration/runtime", async (req, res): Promise<void> => {
  const ownerId = getAuth(req).userId;
  requireOperator(ownerId);
  const parsed = UpdateTelegramRuntimeBody.safeParse(req.body);
  if (!parsed.success) throw new CommerceError("Enter valid Telegram operating settings.");
  await updateBotRuntime(ownerId!, parsed.data, parsed.data.acknowledgePolicy);
  req.log.info({ enabled: parsed.data.enabled, transport: parsed.data.transport }, "Telegram operating settings saved.");
  res.json(GetIntegrationResponse.parse(await integrationStatus(ownerId)));
});
router.post("/integration/credentials/telegram", async (req, res): Promise<void> => {
  const ownerId = getAuth(req).userId;
  requireOperator(ownerId);
  const parsed = SaveTelegramCredentialBody.safeParse(req.body);
  if (!parsed.success) throw new CommerceError("Enter a valid Telegram bot token.");
  const { id: botId, username } = await checkTelegramToken(parsed.data.token);
  const [existing] = await db.select().from(botConnections).where(eq(botConnections.id, "primary"));
  if (existing?.ownerId && existing.ownerId !== ownerId) {
    res.json({ verified: true, botUsername: username, saved: false, message: "Telegram verified this token, but it was not saved because the existing bot is bound to another shop." });
    return;
  }
  if (existing && existing.botId !== String(botId)) {
    res.json({ verified: true, botUsername: username, saved: false, message: "Telegram verified this token, but it was not saved because changing bot identity requires an explicit migration." });
    return;
  }
  await saveTelegramCredential(ownerId!, parsed.data.token, username);
  req.log.info("Telegram bot token verified and saved.");
  res.json({ verified: true, botUsername: username, saved: true, message: "Telegram bot token verified and encrypted for this shop." });
});
router.post("/integration/credentials/nowpayments", async (req, res): Promise<void> => {
  const ownerId = getAuth(req).userId;
  requireOperator(ownerId);
  const parsed = SaveNowpaymentsCredentialsBody.safeParse(req.body);
  if (!parsed.success) throw new CommerceError("Enter a NOWPayments API key and IPN secret.");
  await checkNOWPaymentsKey(parsed.data.apiKey);
  await saveNowpaymentsCredentials(ownerId!, parsed.data.apiKey, parsed.data.ipnSecret);
  req.log.info("NOWPayments API credentials verified and saved.");
  res.json({ verified: true, ipnSecretSaved: true });
});
router.post("/integration/disconnect", async (req, res): Promise<void> => {
  const ownerId = getAuth(req).userId;
  requireOperator(ownerId);
  await updateBotRuntime(ownerId!, { ...await getBotRuntime(ownerId!), enabled: false }, false);
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
