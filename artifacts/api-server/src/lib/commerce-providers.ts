import { createHmac, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import { paymentCaption, paymentKeyboard, type InvoiceMessage } from "./payment-message";
import { readProviderCredentials } from "./provider-credentials";
import { getBotRuntime, legacyPublicUrl } from "./bot-runtime";

export class CommerceError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export class ProviderRejectedError extends CommerceError {}
export class TelegramRequestError extends CommerceError {
  constructor(public operation: string, public providerStatus: number, public reason = "provider_error") {
    super("Telegram could not complete the request. Try again.", 502);
  }
}

// Never propagate provider response bodies/errors: they can contain tokens or payment details.
export async function telegram<T = Record<string, unknown>>(method: string, body: Record<string, unknown> | FormData = {}): Promise<T> {
  if (!(await getBotRuntime()).enabled) {
    throw new CommerceError("Telegram processing is disabled. Enable it in the dashboard.", 503);
  }
  return telegramRequest<T>(method, body);
}

// Administrative calls may configure a paused bot, but may never send messages.
export async function telegramControl<T = Record<string, unknown>>(
  method: "getMe" | "getWebhookInfo" | "setWebhook" | "deleteWebhook", body: Record<string, unknown> = {},
): Promise<T> {
  return telegramRequest<T>(method, body);
}

async function telegramRequest<T>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  const token = (await readProviderCredentials()).telegramToken;
  if (!token) throw new CommerceError("Telegram token is not configured.", 503);
  try {
    const multipart = body instanceof FormData;
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: multipart ? undefined : { "content-type": "application/json" },
      body: multipart ? body : JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    const result = await response.json() as { ok: boolean; result: T; error_code?: number; description?: string };
    if (!response.ok || !result.ok) {
      const d = result.description?.toLowerCase() ?? "";
      const reason = d.includes("message is not modified") ? "not_modified" :
        result.error_code === 400 && (d.includes("emoji") || d.includes("premium")) ? "custom_emoji_unavailable" :
        method === "deleteMessage" && d.includes("message to delete not found") ? "message_missing" :
        method === "deleteMessage" && d.includes("message can't be deleted") ? "cannot_delete" :
        d.includes("terminated by other getupdates") ? "other_poller" :
        d.includes("webhook is active") ? "webhook_active" : "provider_error";
      throw new TelegramRequestError(method, result.error_code ?? response.status, reason);
    }
    return result.result;
  } catch (error) {
    if (error instanceof TelegramRequestError) throw error;
    throw new TelegramRequestError(method, 0);
  }
}

export async function checkTelegramToken(token: string): Promise<{ id: number; username: string }> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: "POST", signal: AbortSignal.timeout(12000),
    });
    const result = await response.json() as { ok: boolean; result?: { id?: number; username?: string }; error_code?: number };
    if (response.status === 401 || result.error_code === 401) throw new CommerceError("Telegram did not accept this bot token. Check it and try again.", 400);
    if (!response.ok || !result.ok || !Number.isSafeInteger(result.result?.id) || typeof result.result?.username !== "string") {
      throw new CommerceError("Telegram could not verify this bot token. Try again shortly.", 502);
    }
    return { id: result.result.id!, username: result.result.username };
  } catch (error) {
    if (error instanceof CommerceError) throw error;
    throw new CommerceError("Could not reach Telegram to verify this token. Try again shortly.", 502);
  }
}

export async function checkNOWPaymentsKey(apiKey: string): Promise<void> {
  try {
    const response = await fetch("https://api.nowpayments.io/v1/currencies", {
      headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(12000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new CommerceError("NOWPayments did not accept this API key. Check it and try again.", 400);
    }
    if (!response.ok) throw new CommerceError("NOWPayments could not verify this API key. Try again shortly.", 502);
    const result = await response.json() as { currencies?: unknown };
    if (!Array.isArray(result.currencies)) throw new CommerceError("NOWPayments returned an unexpected verification response.", 502);
  } catch (error) {
    if (error instanceof CommerceError) throw error;
    throw new CommerceError("Could not reach NOWPayments to verify this API key. Try again shortly.", 502);
  }
}

export interface ProviderPayment {
  payment_id: string | number;
  payment_status: string;
  order_id: string;
  price_amount: number | string;
  price_currency: string;
  pay_currency: string;
  pay_amount: number | string;
  actually_paid?: number | string;
  pay_address: string;
  payin_extra_id?: string | null;
  network?: string;
  expiration_estimate_date?: string;
}
export async function nowpayments<T = ProviderPayment>(path: string, body?: Record<string, unknown>): Promise<T> {
  const key = (await readProviderCredentials()).nowpaymentsApiKey;
  if (!key) throw new CommerceError("NOWPayments API key is not configured.", 503);
  try {
    const response = await fetch(`https://api.nowpayments.io/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { code?: string };
      // Only known validation failures prove no payable invoice was created.
      // Never propagate raw provider messages or mark network/server errors safe.
      const messages: Record<string, string> = {
        AMOUNT_MINIMAL_ERROR: "This amount is below NOWPayments' current minimum for this coin. Start a new deposit with a higher amount or another coin.",
        CURRENCY_NOT_FOUND: "That currency is not currently available at NOWPayments. Choose another coin.",
        INVALID_REQUEST_PARAMS: "NOWPayments rejected the invoice settings. Please contact the shop admin.",
      };
      if (response.status >= 400 && response.status < 500 && failure.code && messages[failure.code]) {
        throw new ProviderRejectedError(messages[failure.code], 400);
      }
      throw new Error();
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof ProviderRejectedError) throw error;
    throw new CommerceError("NOWPayments could not complete the request. Try again shortly or contact support.", 502);
  }
}

export async function checkProviderMinimum(coin: string, amountCents: number, rateMode: "fixed" | "floating" = "fixed") {
  const cents = await providerMinimumCents(coin, rateMode);
  if (amountCents < cents) {
    throw new CommerceError(`NOWPayments currently requires at least $${(cents / 100).toFixed(2)} for ${coin.toUpperCase()} (${rateMode} rate). No invoice was created. Use Wallet → Deposit to enter a higher amount, or choose another coin.`);
  }
}
export async function providerMinimumCents(coin: string, rateMode: "fixed" | "floating") {
  const minimum = await nowpayments<{ fiat_equivalent: number | string }>(
    `/min-amount?currency_from=${encodeURIComponent(coin)}&fiat_equivalent=usd&is_fixed_rate=${rateMode === "fixed"}&is_fee_paid_by_user=false`,
  );
  const usd = Number(minimum.fiat_equivalent);
  if (!Number.isFinite(usd) || usd <= 0) throw new CommerceError("NOWPayments did not return a usable minimum. Please try another coin.", 502);
  return Math.ceil(usd * 100);
}

export function webhookSecret() {
  if (!process.env.SESSION_SECRET) throw new CommerceError("Webhook security is not configured.", 503);
  return createHmac("sha256", process.env.SESSION_SECRET).update("telecart-telegram-webhook-v1").digest("hex");
}
export function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sortedJson(v)]),
  );
  return value;
}
export async function verifyIpn(body: unknown, signature: string): Promise<boolean> {
  const secret = (await readProviderCredentials()).nowpaymentsIpnSecret;
  if (!secret || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  return safeEqual(createHmac("sha512", secret).update(JSON.stringify(sortedJson(body))).digest("hex"), signature.toLowerCase());
}
export function publicBaseUrl() {
  return legacyPublicUrl();
}

export function moneyCents(value: unknown): number {
  if (typeof value !== "string" || !/^\d{1,6}(\.\d{1,2})?$/.test(value)) throw new CommerceError("Enter a USD amount with at most two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (cents < 1 || cents > 10000000) throw new CommerceError("Enter a positive USD amount, up to $100,000, with at most two decimal places. The selected coin may require a higher provider minimum.");
  return cents;
}

// Exact decimal comparison (no floating point tolerance that could authorize an underpayment).
export function decimalAtLeast(actual: unknown, required: unknown): boolean {
  const parts = (v: unknown) => {
    let s = String(v);
    // Provider JSON numbers can serialize very small crypto amounts in exponent notation.
    const scientific = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
    if (scientific) {
      const exponent = Number(scientific[3]);
      if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 40) return null;
      const digits = scientific[1] + (scientific[2] ?? "");
      const point = scientific[1]!.length + exponent;
      s = point <= 0 ? `0.${"0".repeat(-point)}${digits}` :
        point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
    }
    if (!/^\d+(\.\d+)?$/.test(s) || s.length > 100) return null;
    const [whole, fraction = ""] = s.split(".");
    return { whole, fraction };
  };
  const a = parts(actual); const b = parts(required);
  if (!a || !b) return false;
  const scale = Math.max(a.fraction.length, b.fraction.length);
  return BigInt(a.whole + a.fraction.padEnd(scale, "0")) >= BigInt(b.whole + b.fraction.padEnd(scale, "0"));
}

export async function sendPaymentQr(chatId: string, payment: InvoiceMessage) {
  // Encode the provider address itself, not an invented chain-specific URI.
  // Exact amount, coin/network and memo are always written beside it.
  const png = await QRCode.toBuffer(payment.address, { width: 420, margin: 3, errorCorrectionLevel: "M" });
  const caption = paymentCaption(payment);
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "payment.png");
  form.set("caption", caption);
  form.set("parse_mode", "HTML");
  form.set("reply_markup", JSON.stringify(paymentKeyboard(payment)));
  return telegram<{ message_id: number }>("sendPhoto", form);
}
