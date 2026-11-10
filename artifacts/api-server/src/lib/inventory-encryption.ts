import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

function key(purpose: string): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Secure inventory storage is not configured");
  return Buffer.from(hkdfSync("sha256", secret, "telecart-inventory-v1", purpose, 32));
}

export function encryptCredential(value: string, ownerId: string, productId: number) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("encryption"), iv);
  cipher.setAAD(Buffer.from(`${ownerId}:${productId}`));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}

export function credentialFingerprint(value: string, ownerId: string, productId: number) {
  return createHmac("sha256", key("deduplication")).update(`${ownerId}:${productId}:${value}`).digest("hex");
}
