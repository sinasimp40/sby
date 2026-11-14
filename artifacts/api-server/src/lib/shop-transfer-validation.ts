import { CommerceError } from "./commerce-providers";
import { decryptCredential, credentialFingerprint } from "./inventory-encryption";
import { decryptProviderSecret } from "./provider-credentials";
import { tableKeys, type TransferData, type TransferRow } from "./shop-transfer-tables";
import { assignedInventoryIds } from "./payment-inventory";
import { isProductEmoji } from "./product-emoji";
import { customEmojiIdValid, MAX_CUSTOM_EMOJIS } from "./custom-emoji-library";
import { SaveSettingsBody } from "@workspace/api-zod";
import { validCoinNormalIcon } from "./coin-button-icons";
import { coinNames } from "./deposit-coin-buttons";
import { validProductMediaUrl } from "./product-media";
import { parseAdvertisingTarget } from "./advertising-targets";
import { validateAdvertisingDraft } from "./advertising-telegram";
import type { AdvertisingDraft } from "@workspace/api-zod";
import { parseMessageEmojis } from "@workspace/api-zod";
import { accountMessage } from "./advertising-account-driver";

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
    for (const key of ["settings", "providerCredentials", "runtime", "connection", "advertisingBots", "promotionSettings"] as const) {
      if (data[key].length > 1) throw new Error();
    }
    area = "duplicate identifiers";
    const products = indexed(data.products);
    const inventory = indexed(data.inventory);
    const customers = indexed(data.customers);
    const payments = indexed(data.payments);
    indexed(data.walletEntries);
    indexed(data.walletEntries, "paymentId");
    indexed(data.manualCredits);
    indexed(data.manualCredits, "requestKey");
    area = "customer promotion relationships";
    indexed(data.promotionProducts, "productId");
    indexed(data.promotionPreferences, "customerId");
    const promoRounds = indexed(data.promotionRounds);
    indexed(data.promotionDeliveries);
    const deliveryKeys = new Set<string>();
    for (const flag of data.promotionProducts) if (!products.has(flag.productId)) throw new Error();
    for (const pref of data.promotionPreferences) if (!customers.has(pref.customerId)) throw new Error();
    for (const round of data.promotionRounds) {
      if (round.productId !== null && !products.has(round.productId) || !["running", "completed", "stopped"].includes(String(round.status)) ||
        typeof round.productName !== "string" || round.productName.length > 200 ||
        typeof round.info !== "string" || round.info.length > 500 ||
        [round.sent, round.failed, round.uncertain, round.skipped].some(n => !Number.isSafeInteger(n) || Number(n) < 0)) throw new Error();
    }
    for (const config of data.promotionSettings) {
      if (!Number.isSafeInteger(config.intervalMinutes) || Number(config.intervalMinutes) < 1 || Number(config.intervalMinutes) > 43200 ||
        config.activeRoundId !== null && promoRounds.get(config.activeRoundId)?.status !== "running" ||
        (config.leaseToken === null) !== (config.leaseUntil === null) ||
        typeof config.info !== "string" || config.info.length > 500) throw new Error();
    }
    for (const delivery of data.promotionDeliveries) {
      const key = JSON.stringify([delivery.roundId, delivery.customerId]);
      if (!promoRounds.has(delivery.roundId) || !customers.has(delivery.customerId) || deliveryKeys.has(key) ||
        !["sending", "retry", "sent", "failed", "unknown", "skipped"].includes(String(delivery.status)) ||
        !Number.isSafeInteger(delivery.attempts) || Number(delivery.attempts) < 0 || Number(delivery.attempts) > 3 ||
        typeof delivery.error !== "string" || delivery.error.length > 500 ||
        delivery.messageId !== null && (!Number.isSafeInteger(delivery.messageId) || Number(delivery.messageId) < 1)) throw new Error();
      deliveryKeys.add(key);
    }
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
        !["active", "draft", "archived"].includes(String(p.status)) || (p.buttonEmoji !== "" && !isProductEmoji(p.buttonEmoji)) ||
        (p.buttonCustomEmojiId !== null && !customEmojis.has(p.buttonCustomEmojiId))) throw new Error();
    }
    area = "deposit coin icons";
    for (const settings of data.settings) {
      // Inspect only; never reserialize the original lossless JSONB text.
      const preferences = JSON.parse(settings.preferences as string) as Record<string, unknown>;
      if (preferences?.welcomeImageUrl != null &&
        (typeof preferences.welcomeImageUrl !== "string" || !validProductMediaUrl(preferences.welcomeImageUrl) ||
          typeof preferences.welcomeMessage !== "string" || parseMessageEmojis(preferences.welcomeMessage).text.length > 1024)) throw new Error();
      for (const message of [preferences.welcomeMessage, preferences.supportMessage]) {
        if (typeof message === "string" && parseMessageEmojis(message).entities.some(entity => !customEmojis.has(entity.custom_emoji_id))) throw new Error();
      }
      const parsed = SaveSettingsBody.shape.coinButtonIcons.safeParse(preferences?.coinButtonIcons);
      if (!parsed.success) throw new Error();
      const icons = parsed.data ?? {};
      if (Object.keys(icons).length > 7) throw new Error();
      for (const [coin, icon] of Object.entries(icons)) {
        if (!Object.hasOwn(coinNames, coin) || !validCoinNormalIcon(icon.emoji) ||
          (icon.customEmojiId != null && !customEmojis.has(icon.customEmojiId))) throw new Error();
      }
    }
    area = "product option groups";
    const groups = new Map<string, string>();
    for (const p of data.products) {
      if (p.groupId === null) {
        if (p.groupName !== null || p.groupDescription !== null || p.optionName !== null) throw new Error();
        continue;
      }
      if (typeof p.groupId !== "string" || !/^[0-9a-f-]{36}$/i.test(p.groupId) ||
        typeof p.groupName !== "string" || !p.groupName.trim() || p.groupName.length > 80 ||
        typeof p.groupDescription !== "string" || typeof p.optionName !== "string" || !p.optionName.trim() || p.optionName.length > 36 ||
        p.name !== `${p.groupName} — ${p.optionName}`) throw new Error();
      const shared = JSON.stringify([p.groupName, p.groupDescription, p.imageUrl, p.buttonEmoji, p.buttonCustomEmojiId]);
      if (groups.has(p.groupId) && groups.get(p.groupId) !== shared) throw new Error();
      groups.set(p.groupId, shared);
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
    for (const entry of data.manualCredits) {
      area = "manual wallet credit references";
      if (!customers.has(entry.customerId) || typeof entry.id !== "string" || !/^[0-9a-f-]{36}$/i.test(entry.id) ||
        typeof entry.requestKey !== "string" || !/^[0-9a-f-]{36}$/i.test(entry.requestKey) ||
        typeof entry.actorId !== "string" || !entry.actorId.trim() || entry.actorId.length > 300 ||
        typeof entry.reason !== "string" || !entry.reason.trim() || entry.reason.length > 500 ||
        !Number.isSafeInteger(entry.amountCents) || Number(entry.amountCents) <= 0 ||
        !Number.isSafeInteger(entry.balanceBeforeCents) || Number(entry.balanceBeforeCents) < 0 ||
        !Number.isSafeInteger(entry.balanceAfterCents) || Number(entry.balanceAfterCents) > 2000000000 ||
        Number(entry.balanceAfterCents) !== Number(entry.balanceBeforeCents) + Number(entry.amountCents)) throw new Error();
    }
    area = "bot identity";
    const connection = data.connection[0];
    if (connection && (connection.id !== "primary" || !/^\d+$/.test(String(connection.botId)))) throw new Error();
    if (data.updates.some(row => !connection || !String(row.id).startsWith(`${connection.botId}:`))) throw new Error();
    area = "provider credential encryption";
    const advertising = data.advertisingBots[0];
    const jsonDraft = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as AdvertisingDraft;
    if (advertising) {
      validateAdvertisingDraft(jsonDraft(advertising.draft));
      if (advertising.tokenEncrypted !== null) {
        const token = decryptProviderSecret(String(advertising.tokenEncrypted), ownerId, "advertising");
        if (token.split(":")[0] !== advertising.botId || String(advertising.botId) === String(connection?.botId)) throw new Error();
      } else if (advertising.botId !== null) throw new Error();
    }
    area = "advertising groups and delivery history";
    if (data.advertisingGroups.length > 1000) throw new Error();
    indexed(data.advertisingGroups); indexed(data.advertisingGroups, "target");
    indexed(data.advertisingGroups.filter(row => row.chatId !== null), "chatId");
    for (const group of data.advertisingGroups) {
      const parsed = parseAdvertisingTarget(String(group.target));
      if (parsed.target !== group.target || parsed.kind !== group.kind ||
        !["pending", "ready", "needs_setup", "duplicate", "error", "removed"].includes(String(group.status)) ||
        (group.chatId !== null && !/^-[1-9]\d{5,15}$/.test(String(group.chatId))) ||
        (group.status === "ready" && group.chatId === null)) throw new Error();
    }
    const adCampaigns = indexed(data.advertisingCampaigns);
    indexed(data.advertisingDeliveries);
    const recipients = new Set<string>();
    for (const campaign of data.advertisingCampaigns) {
      if (!["queued", "sending", "completed", "partial", "cancelled"].includes(String(campaign.status))) throw new Error();
      validateAdvertisingDraft(jsonDraft(campaign.draft), true);
    }
    for (const delivery of data.advertisingDeliveries) {
      const key = `${delivery.campaignId}:${delivery.chatId}`;
      if (!adCampaigns.has(delivery.campaignId) || recipients.has(key) ||
        !/^-[1-9]\d{5,15}$/.test(String(delivery.chatId)) ||
        !["pending", "sending", "sent", "failed", "uncertain", "cancelled"].includes(String(delivery.status))) throw new Error();
      recipients.add(key);
    }
    area = "account advertising schedules and history";
    const adGroups = indexed(data.advertisingGroups);
    indexed(data.advertisingAccountSchedules, "groupId");
    for (const schedule of data.advertisingAccountSchedules) {
      if (!adGroups.has(schedule.groupId) || Number(schedule.intervalSeconds) < 60 || Number(schedule.intervalSeconds) > 2592000 ||
        Number(schedule.revision) < 0 || Number(schedule.accountGeneration) < 0 || (schedule.running && (!schedule.draft || !schedule.nextSendAt))) throw new Error();
      if (schedule.draft !== null) accountMessage(jsonDraft(schedule.draft));
    }
    indexed(data.advertisingAccountRuns);
    const occurrences = new Set<string>();
    for (const run of data.advertisingAccountRuns) {
      const key = `${run.groupId}:${run.revision}:${run.scheduledFor}`;
      if (occurrences.has(key) || !/^-[1-9]\d{5,15}$/.test(String(run.chatId)) ||
        !/^-?\d{1,20}$/.test(String(run.randomId)) ||
        !["sending", "sent", "failed", "uncertain", "cancelled", "rate_limited"].includes(String(run.status))) throw new Error();
      occurrences.add(key); accountMessage(jsonDraft(run.draft));
    }
    indexed(data.advertisingAccountCommands); indexed(data.advertisingAccountCommands, "requestKey");
    if (data.advertisingAccountCommands.some(row => !/^[a-f0-9]{64}$/.test(String(row.payloadHash)))) throw new Error();
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
