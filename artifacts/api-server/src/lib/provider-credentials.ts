import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, providerCredentials } from "@workspace/db";
import { configuredOwnerId } from "./admin-bootstrap";
import { CommerceError } from "./commerce-providers";

type CredentialField = "telegram" | "nowpayments-api-key" | "nowpayments-ipn-secret";
export type ProviderCredentialValues = {
  telegramToken: string | null;
  nowpaymentsApiKey: string | null;
  nowpaymentsIpnSecret: string | null;
};

function encryptionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new CommerceError("Credential encryption is unavailable.", 503);
  return createHmac("sha256", secret).update("telecart-provider-credentials-v1").digest();
}

export function encryptProviderSecret(value: string, ownerId: string, field: CredentialField) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`${ownerId}:${field}`));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptProviderSecret(value: string, ownerId: string, field: CredentialField) {
  const [version, iv, tag, ciphertext, extra] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext || extra) {
    throw new CommerceError("Saved provider credentials cannot be decrypted. Check whether SESSION_SECRET changed.", 503);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(`${ownerId}:${field}`));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new CommerceError("Saved provider credentials cannot be decrypted. Check whether SESSION_SECRET changed.", 503);
  }
}

export async function readProviderCredentials(ownerId = configuredOwnerId()): Promise<ProviderCredentialValues> {
  if (!ownerId) return { telegramToken: null, nowpaymentsApiKey: null, nowpaymentsIpnSecret: null };
  const [row] = await db.select().from(providerCredentials).where(eq(providerCredentials.ownerId, ownerId));
  return {
    telegramToken: row?.telegramTokenEncrypted
      ? decryptProviderSecret(row.telegramTokenEncrypted, ownerId, "telegram")
      : process.env.TELEGRAM_BOT_TOKEN || null,
    nowpaymentsApiKey: row?.nowpaymentsApiKeyEncrypted
      ? decryptProviderSecret(row.nowpaymentsApiKeyEncrypted, ownerId, "nowpayments-api-key")
      : process.env.NOWPAYMENTS_API_KEY || null,
    nowpaymentsIpnSecret: row?.nowpaymentsIpnSecretEncrypted
      ? decryptProviderSecret(row.nowpaymentsIpnSecretEncrypted, ownerId, "nowpayments-ipn-secret")
      : process.env.NOWPAYMENTS_IPN_SECRET || null,
  };
}

export async function saveTelegramCredential(ownerId: string, token: string, username: string) {
  const [existing] = await db.select().from(providerCredentials).where(eq(providerCredentials.ownerId, ownerId));
  await db.insert(providerCredentials).values({
    ownerId,
    telegramTokenEncrypted: encryptProviderSecret(token, ownerId, "telegram"),
    telegramVerifiedAt: new Date(),
    telegramBotUsername: username,
    nowpaymentsApiKeyEncrypted: existing?.nowpaymentsApiKeyEncrypted ?? null,
    nowpaymentsVerifiedAt: existing?.nowpaymentsVerifiedAt ?? null,
    nowpaymentsIpnSecretEncrypted: existing?.nowpaymentsIpnSecretEncrypted ?? null,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: providerCredentials.ownerId,
    set: { telegramTokenEncrypted: encryptProviderSecret(token, ownerId, "telegram"), telegramVerifiedAt: new Date(), telegramBotUsername: username, updatedAt: new Date() },
  });
}

export async function saveNowpaymentsCredentials(ownerId: string, apiKey: string, ipnSecret: string) {
  const [existing] = await db.select().from(providerCredentials).where(eq(providerCredentials.ownerId, ownerId));
  const apiKeyEncrypted = encryptProviderSecret(apiKey, ownerId, "nowpayments-api-key");
  const ipnSecretEncrypted = encryptProviderSecret(ipnSecret, ownerId, "nowpayments-ipn-secret");
  await db.insert(providerCredentials).values({
    ownerId,
    telegramTokenEncrypted: existing?.telegramTokenEncrypted ?? null,
    telegramVerifiedAt: existing?.telegramVerifiedAt ?? null,
    nowpaymentsApiKeyEncrypted: apiKeyEncrypted,
    nowpaymentsVerifiedAt: new Date(),
    nowpaymentsIpnSecretEncrypted: ipnSecretEncrypted,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: providerCredentials.ownerId,
    set: {
      nowpaymentsApiKeyEncrypted: apiKeyEncrypted,
      nowpaymentsVerifiedAt: new Date(),
      nowpaymentsIpnSecretEncrypted: ipnSecretEncrypted,
      updatedAt: new Date(),
    },
  });
}

export async function providerCredentialStatus(ownerId: string) {
  const [row] = await db.select().from(providerCredentials).where(eq(providerCredentials.ownerId, ownerId));
  return {
    telegramVerified: Boolean(row?.telegramVerifiedAt || process.env.TELEGRAM_BOT_TOKEN),
    verifiedBotUsername: row?.telegramBotUsername ?? "",
    nowpaymentsVerified: Boolean(row?.nowpaymentsVerifiedAt || process.env.NOWPAYMENTS_API_KEY),
    ipnSecretPresent: Boolean(row?.nowpaymentsIpnSecretEncrypted || process.env.NOWPAYMENTS_IPN_SECRET),
    telegramTokenPresent: Boolean(row?.telegramTokenEncrypted || process.env.TELEGRAM_BOT_TOKEN),
    nowpaymentsApiKeyPresent: Boolean(row?.nowpaymentsApiKeyEncrypted || process.env.NOWPAYMENTS_API_KEY),
  };
}
