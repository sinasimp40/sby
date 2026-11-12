import { CommerceError } from "./commerce-providers";
import { decryptCredential, credentialFingerprint } from "./inventory-encryption";
import { decryptProviderSecret } from "./provider-credentials";
import { tableKeys, type TransferData, type TransferRow } from "./shop-transfer-tables";
import { assignedInventoryIds } from "./payment-inventory";
import { isProductEmoji } from "./product-emoji";
import { customEmojiIdValid, MAX_CUSTOM_EMOJIS } from "./custom-emoji-library";

export function validateShopRelationships(data: TransferData, ownerId: string) {
  let area = "ownership";
  try {
    const indexed = (rows: TransferRow[], key = "id") => {
      const map = new Map(rows.map(row => [row[key], row]));
      if (map.size !== rows.length) throw new Error();
      return map;
    };
    for (const key of tableKeys) for (const row of data[key]) {
      if ("ownerId" in row && row.ownerId !== ownerId) throw new Error();
    }
    for (const key of ["settings", "providerCredentials", "runtime", "connection"] as const) {
      if (data[key].length > 1) throw new Error();
    }
    area = "duplicate identifiers";
    const products = indexed(data.products);
    const inventory = indexed(data.inventory);
    const customers = indexed(data.customers);
    const payments = indexed(data.payments);
    indexed(data.walletEntries);
    indexed(data.walletEntries, "paymentId");
    indexed(data.updates);
    indexed(data.customers, "telegramId");
    indexed(data.payments, "requestKey");
    indexed(data.payments.filter(p => p.providerPaymentId !== null), "providerPaymentId");
    const fingerprints = new Set<string>();
    area = "product values";
    const customEmojis = indexed(data.customEmojis, "customEmojiId");
    if (customEmojis.size > MAX_CUSTOM_EMOJIS) throw new Error();
    for (const emoji of data.customEmojis) {
      if (!customEmojiIdValid(emoji.customEmojiId) || !isProductEmoji(emoji.emoji) ||
        !["static", "animated", "video"].includes(String(emoji.format))) throw new Error();
    }
    for (const p of data.products) {
      if (!Number.isSafeInteger(p.id) || Number(p.id) <= 0 || Number(p.priceCents) < 0 ||
        !["active", "draft", "archived"].includes(String(p.status)) || !isProductEmoji(p.buttonEmoji) ||
        (p.buttonCustomEmojiId !== null && !customEmojis.has(p.buttonCustomEmojiId))) throw new Error();
    }
    area = "inventory links and encryption";
    for (const stock of data.inventory) {
      if (!products.has(stock.productId) || !["available", "reserved", "delivered"].includes(String(stock.status))) throw new Error();
      const plain = decryptCredential(String(stock.encryptedCredential), ownerId, Number(stock.productId));
      if (credentialFingerprint(plain, ownerId, Number(stock.productId)) !== stock.fingerprint) throw new Error();
      const fingerprint = `${stock.productId}:${stock.fingerprint}`;
      if (fingerprints.has(fingerprint)) throw new Error();
      fingerprints.add(fingerprint);
    }
    area = "customer balances";
    for (const c of data.customers) if (Number(c.balanceCents) < 0 || !c.id || !c.telegramId) throw new Error();
    area = "payment references";
    for (const p of data.payments) {
      const ids = assignedInventoryIds(p);
      if (!Number.isSafeInteger(p.quantity) || Number(p.quantity) < 1 || Number(p.quantity) > 100 ||
        (ids.length > 0 && ids.length !== p.quantity) ||
        ids.some(id => !inventory.has(id) || inventory.get(id)!.productId !== p.productId)) throw new Error();
      if (!customers.has(p.customerId) || Number(p.amountCents) <= 0 ||
        (p.productId !== null && !products.has(p.productId)) ||
        (p.inventoryId !== null && (!inventory.has(p.inventoryId) || inventory.get(p.inventoryId)!.productId !== p.productId))) throw new Error();
    }
    area = "wallet credit references";
    for (const entry of data.walletEntries) {
      const p = payments.get(entry.paymentId);
      if (!p || !customers.has(entry.customerId) || p.customerId !== entry.customerId) throw new Error();
      const credit = p.kind === "deposit" && p.fulfillment === "credited" && entry.amountCents === p.amountCents;
      const debit = p.kind === "wallet" && Number(entry.amountCents) === -Number(p.amountCents);
      if (!credit && !debit) throw new Error();
    }
    area = "bot identity";
    const connection = data.connection[0];
    if (connection && (connection.id !== "primary" || !/^\d+$/.test(String(connection.botId)))) throw new Error();
    if (data.updates.some(row => !connection || !String(row.id).startsWith(`${connection.botId}:`))) throw new Error();
    area = "provider credential encryption";
    const credentials = data.providerCredentials[0];
    if (credentials) {
      for (const [field, purpose] of [
        ["telegramTokenEncrypted", "telegram"], ["nowpaymentsApiKeyEncrypted", "nowpayments-api-key"],
        ["nowpaymentsIpnSecretEncrypted", "nowpayments-ipn-secret"],
      ] as const) {
        if (credentials[field] !== null) decryptProviderSecret(String(credentials[field]), ownerId, purpose);
      }
    }
  } catch {
    throw new CommerceError(`Archive relationships, balances or encrypted records could not be verified (${area}). Nothing was imported.`, 400);
  }
}
