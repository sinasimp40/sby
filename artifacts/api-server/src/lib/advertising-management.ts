import { pool } from "@workspace/db";
import { purgeAdvertisingGroup } from "./advertising-group-purge";
import { CommerceError } from "./commerce-providers";
import { encryptProviderSecret, decryptProviderSecret } from "./provider-credentials";
import { advertisingBotForOwner, withAdvertisingLock, type AdvertisingClient } from "./advertising-store";
import { advertisingTelegram, AdvertisingTelegramError, inspectAdvertisingGroup, type AdvertisingCaller } from "./advertising-telegram";
import { parseAdvertisingTarget } from "./advertising-targets";

export async function connectAdvertising(owner: string, token: string, call: AdvertisingCaller = advertisingTelegram) {
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,150}$/.test(token)) throw new CommerceError("Paste the full advertising bot token from BotFather.");
  return withAdvertisingLock(owner, async client => {
    const me = await call<{ id: number; username: string; is_bot: boolean }>(token, "getMe");
    if (!me.is_bot || !Number.isSafeInteger(me.id) || me.id <= 0 || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(me.username ?? ""))
      throw new CommerceError("Telegram did not return a valid bot identity. Nothing was changed.");
    if (String(me.id) !== token.split(":")[0]) throw new CommerceError("Telegram bot identity could not be verified.");
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,74))", [`telegram-bot:${me.id}`]);
      const shop = await client.query(`SELECT 1 FROM bot_connections WHERE bot_id=$1
        UNION ALL SELECT 1 FROM provider_credentials WHERE lower(telegram_bot_username)=lower($2)`, [String(me.id), me.username]);
      // Stay on this write transaction's connection. An unrelated ORM read
      // would wait for the SQLite writer mutex that this transaction owns.
      const saved = (await client.query("SELECT telegram_token_encrypted FROM provider_credentials WHERE owner_id=$1", [owner])).rows[0];
      const shopToken = saved?.telegram_token_encrypted
        ? decryptProviderSecret(saved.telegram_token_encrypted, owner, "telegram")
        : process.env.TELEGRAM_BOT_TOKEN;
      if (shop.rowCount || shopToken?.split(":")[0] === String(me.id))
        throw new CommerceError("This is a shop bot. Connect a different bot for advertising.");
      const existing = (await client.query("SELECT bot_id FROM advertising_bots WHERE owner_id=$1", [owner])).rows[0];
      const other = await client.query("SELECT 1 FROM advertising_bots WHERE bot_id=$1 AND owner_id<>$2", [String(me.id), owner]);
      if (other.rowCount) throw new CommerceError("This advertising bot is already connected to another shop.", 409);
      if (existing?.bot_id !== String(me.id)) {
        await stopAdvertising(owner, client);
        await client.query("UPDATE advertising_groups SET status='pending',checked_at=NULL,note='Advertising bot changed. Recheck posting permissions.' WHERE owner_id=$1 AND status<>'removed'", [owner]);
      }
      await client.query(`INSERT INTO advertising_bots(owner_id,bot_id,username,token_encrypted,checked_at)
        VALUES($1,$2,$3,$4,now()) ON CONFLICT(owner_id) DO UPDATE SET bot_id=EXCLUDED.bot_id,username=EXCLUDED.username,
        token_encrypted=EXCLUDED.token_encrypted,checked_at=now(),last_error=NULL,
        update_offset=CASE WHEN advertising_bots.bot_id=EXCLUDED.bot_id THEN advertising_bots.update_offset ELSE 0 END`,
        [owner, String(me.id), me.username, encryptProviderSecret(token, owner, "advertising")]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}
export async function stopAdvertising(owner: string, client: AdvertisingClient) {
  await client.query("UPDATE advertising_deliveries SET status='cancelled',note='Advertising connection stopped or changed.' WHERE owner_id=$1 AND status='pending'", [owner]);
  await client.query("UPDATE advertising_deliveries SET status='uncertain',note='Interrupted send; check Telegram before resending.' WHERE owner_id=$1 AND status='sending'", [owner]);
  await client.query("UPDATE advertising_campaigns SET status='cancelled' WHERE owner_id=$1 AND status IN ('queued','sending')", [owner]);
}
export async function addAdvertisingTargets(owner: string, targets: string[], permission: boolean) {
  if (!permission) throw new CommerceError("Confirm you have permission to advertise in these groups.");
  const rows = targets.map(parseAdvertisingTarget);
  if (rows.some(row => !row.target)) throw new CommerceError("Remove invalid entries before adding groups.");
  return withAdvertisingLock(owner, async client => {
    const count = (await client.query("SELECT count(*)::integer AS n FROM advertising_groups WHERE owner_id=$1", [owner])).rows[0].n;
    if (count + new Set(rows.map(row => row.target)).size > 1000) throw new CommerceError("This dashboard supports up to 1,000 saved advertising groups.");
    await client.query("BEGIN");
    try {
      for (const row of rows) await client.query(`INSERT INTO advertising_groups(owner_id,target,kind,status,note)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,target) DO NOTHING`, [
        owner, row.target, row.kind, row.kind === "private_invite" ? "needs_setup" : "pending", row.reason,
      ]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}
export async function checkAdvertisingTargets(owner: string, ids: string[], call: AdvertisingCaller = advertisingTelegram) {
  return withAdvertisingLock(owner, async client => {
    const { row, token } = await advertisingBotForOwner(owner, client);
    const groups = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, ids])).rows;
    if (groups.length !== ids.length) throw new CommerceError("One or more selected groups were not found.", 404);
    for (const group of groups) {
      if (group.status === "removed") throw new CommerceError("This destination was removed. Restore it through the reviewed membership import.");
      if (group.kind === "private_invite") {
        await client.query("UPDATE advertising_groups SET status='needs_setup',note=$3,checked_at=now() WHERE owner_id=$1 AND id=$2",
          [owner, group.id, "Add the bot manually, then use Find groups or edit this target to the group's negative chat ID."]);
        continue;
      }
      try {
        const verified = await inspectAdvertisingGroup(token, row.bot_id, group.target, call);
        const duplicate = await client.query("SELECT 1 FROM advertising_groups WHERE owner_id=$1 AND chat_id=$2 AND id<>$3", [owner, verified.chatId, group.id]);
        if (duplicate.rowCount) {
          await purgeAdvertisingGroup(owner, client, group.id, { duplicateChatId: verified.chatId });
        } else {
          await client.query("UPDATE advertising_groups SET chat_id=$3,title=$4,status='ready',note='Bot membership and posting permission verified.',checked_at=now() WHERE owner_id=$1 AND id=$2",
            [owner, group.id, verified.chatId, verified.title.slice(0, 200)]);
        }
      } catch (error) {
        if (!(error instanceof CommerceError)) throw error;
        await client.query("UPDATE advertising_groups SET status='error',note=$3,checked_at=now() WHERE owner_id=$1 AND id=$2", [owner, group.id, error.message]);
        if (error instanceof AdvertisingTelegramError && [0, 401, 429].includes(error.providerCode)) throw error;
      }
    }
  });
}
export async function discoverAdvertisingTargets(owner: string, call: AdvertisingCaller = advertisingTelegram) {
  return withAdvertisingLock(owner, async client => {
    const { row, token } = await advertisingBotForOwner(owner, client);
    const webhook = await call<{ url?: string }>(token, "getWebhookInfo");
    if (webhook.url) throw new CommerceError("This advertising bot has an existing webhook. Remove it in its other app before discovery, or add groups by @username/chat ID. Nothing was changed.", 409);
    const updates = await call<Array<{ update_id: number; my_chat_member?: { chat?: { id: number; type: string; title?: string }; new_chat_member?: { status: string } } }>>(token, "getUpdates",
      { offset: row.update_offset, timeout: 0, limit: 100, allowed_updates: ["my_chat_member"] });
    const count = (await client.query("SELECT count(*)::integer AS n FROM advertising_groups WHERE owner_id=$1", [owner])).rows[0].n;
    let added = 0;
    for (const update of updates) {
      const event = update.my_chat_member, chat = event?.chat;
      if (!chat || !["group", "supergroup", "channel"].includes(chat.type)) continue;
      if (["left", "kicked"].includes(event?.new_chat_member?.status ?? "")) {
        await client.query("UPDATE advertising_groups SET status='needs_setup',note='Bot is no longer a member of this chat.' WHERE owner_id=$1 AND status<>'removed' AND (chat_id=$2 OR target=$2)", [owner, String(chat.id)]);
        continue;
      }
      if (count + added >= 1000) throw new CommerceError("Group limit reached. Remove unused groups before discovering more.");
      const exists = await client.query("SELECT 1 FROM advertising_groups WHERE owner_id=$1 AND (chat_id=$2 OR target=$2)", [owner, String(chat.id)]);
      if (!exists.rowCount) {
        await client.query("INSERT INTO advertising_groups(owner_id,target,kind,title,note) VALUES($1,$2,'chat_id',$3,'Discovered group; confirm permission and check before sending.') ON CONFLICT DO NOTHING", [owner, String(chat.id), chat.title?.slice(0, 200) ?? ""]);
        added++;
      }
    }
    if (updates.length) await client.query("UPDATE advertising_bots SET update_offset=$2 WHERE owner_id=$1", [owner, Math.max(...updates.map(update => update.update_id)) + 1]);
  });
}
