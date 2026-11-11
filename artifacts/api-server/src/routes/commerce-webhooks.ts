import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, shopPayments } from "@workspace/db";
import { CommerceError, safeEqual, verifyIpn, webhookSecret } from "../lib/commerce-providers";
import { checkPayment } from "../lib/commerce-payments";
import { handleTelegramUpdate } from "../lib/telegram-shop";
import { getBotRuntime } from "../lib/bot-runtime";

const router: IRouter = Router();
router.post("/telegram/webhook", async (req, res): Promise<void> => {
  if (!process.env.SESSION_SECRET || !safeEqual(req.get("x-telegram-bot-api-secret-token") ?? "", webhookSecret())) {
    res.status(401).json({ error: "Invalid Telegram webhook signature." }); return;
  }
  const runtime = await getBotRuntime();
  if (!runtime.enabled || runtime.transport !== "webhook") {
    res.status(503).json({ error: "Telegram webhook processing is disabled." }); return;
  }
  await handleTelegramUpdate(req.body);
  res.sendStatus(200);
});
router.post("/nowpayments/ipn", async (req, res): Promise<void> => {
  if (!await verifyIpn(req.body, req.get("x-nowpayments-sig") ?? "")) {
    res.status(401).json({ error: "Invalid NOWPayments signature." }); return;
  }
  const id = req.body?.payment_id;
  if (!["string", "number"].includes(typeof id) || !/^\d+$/.test(String(id))) throw new CommerceError("Invalid payment notification.");
  const [payment] = await db.select().from(shopPayments).where(eq(shopPayments.providerPaymentId, String(id)));
  if (!payment) {
    // This can race payment creation. Return retryable status instead of losing the notification.
    res.status(503).json({ error: "Payment is not registered yet. Retry notification." }); return;
  }
  // Callback authenticates the notification, but NEVER authorizes fulfillment by itself.
  // Fetch authoritative state from NOWPayments even if the payload says 'finished'.
  await checkPayment(payment.id);
  res.sendStatus(200);
});
export default router;
