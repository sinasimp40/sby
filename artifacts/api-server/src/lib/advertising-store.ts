import { pool } from "@workspace/db";
import type { AdvertisingWorkspace, AdvertisingCampaign } from "@workspace/api-zod";
import type { PoolClient } from "@workspace/db";
import { CommerceError } from "./commerce-providers";
import { decryptProviderSecret } from "./provider-credentials";
import { accountStatus } from "./advertising-account-auth";
import { ownerForwardLoop } from "./advertising-forward-loop";
import { advertisingActivity } from "./advertising-activity";
import { membershipJobs } from "./advertising-membership-store";
import { resumeSummary } from "./advertising-checkpoint-store";

export type AdvertisingClient = PoolClient;
export async function withAdvertisingLock<T>(owner: string, fn: (client: AdvertisingClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,72))", [`advertising:${owner}`]);
    return await fn(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1,72))", [`advertising:${owner}`]).catch(() => {});
    client.release();
  }
}
export async function advertisingBotForOwner(owner: string, client: Pick<AdvertisingClient, "query"> = pool) {
  const row = (await client.query("SELECT * FROM advertising_bots WHERE owner_id=$1", [owner])).rows[0];
  if (!row?.token_encrypted || !row.bot_id) throw new CommerceError("Connect a separate advertising bot first.", 409);
  return { row, token: decryptProviderSecret(row.token_encrypted, owner, "advertising") };
}
const campaignQuery = `SELECT c.id,c.status,c.draft->>'text' AS text,c.created_at AS "createdAt",
 count(d.id)::integer AS total,
 count(*) FILTER(WHERE d.status='sent')::integer AS sent,
 count(*) FILTER(WHERE d.status='failed')::integer AS failed,
 count(*) FILTER(WHERE d.status='uncertain')::integer AS uncertain,
 count(*) FILTER(WHERE d.status IN ('pending','sending'))::integer AS pending,
 count(*) FILTER(WHERE d.status='cancelled')::integer AS cancelled
 FROM advertising_campaigns c LEFT JOIN advertising_deliveries d ON d.campaign_id=c.id`;
export async function advertisingCampaigns(owner: string, id?: string): Promise<AdvertisingCampaign[]> {
  const rows = (await pool.query(`${campaignQuery} WHERE c.owner_id=$1 ${id ? "AND c.id=$2" : ""}
    GROUP BY c.id ORDER BY c.created_at DESC LIMIT 30`, id ? [owner, id] : [owner])).rows;
  return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })) as AdvertisingCampaign[];
}
export async function advertisingWorkspace(owner: string): Promise<AdvertisingWorkspace> {
  const [bots, groups, campaigns, shops] = await Promise.all([
    pool.query("SELECT username,token_encrypted IS NOT NULL AS configured, checked_at,last_error FROM advertising_bots WHERE owner_id=$1", [owner]),
    pool.query(`SELECT g.id,g.target,g.kind,g.title,g.chat_id AS "chatId",g.enabled,g.status,g.note,g.checked_at AS "checkedAt",
      COALESCE(s.interval_seconds,1800) AS "intervalSeconds",COALESCE(s.running,false) AS running,s.next_send_at AS "nextSendAt",
      COALESCE(s.last_status,'stopped') AS "lastStatus",COALESCE(s.note,'Select and start this group to begin.') AS "scheduleNote"
      FROM advertising_groups g LEFT JOIN advertising_schedules s ON s.group_id=g.id AND s.owner_id=g.owner_id
      WHERE g.owner_id=$1 AND g.status<>'removed' ORDER BY g.title,g.target`, [owner]),
    advertisingCampaigns(owner),
    pool.query("SELECT telegram_bot_username AS username FROM provider_credentials WHERE owner_id=$1", [owner]),
  ]);
  const bot = bots.rows[0];
  const draftRow = (await pool.query("SELECT draft FROM advertising_bots WHERE owner_id=$1", [owner])).rows[0];
  const runs = await advertisingActivity(owner);
  return {
    membershipJobs: await membershipJobs(owner),
    resume: await resumeSummary(owner),
    forwarding: await ownerForwardLoop(owner, draftRow?.draft ?? { text: "", imageUrl: null, buttonText: "", buttonUrl: null }),
    account: await accountStatus(owner),
    accountRuns: runs,
    bot: { configured: Boolean(bot?.configured), connected: Boolean(bot?.configured && bot.checked_at && !bot.last_error),
      username: bot?.username ?? "", botLink: bot?.username ? `https://t.me/${bot.username}` : null,
      checkedAt: bot?.checked_at?.toISOString() ?? null, error: bot?.last_error ?? null },
    draft: draftRow?.draft ?? { text: "", imageUrl: null, buttonText: "Visit shop", buttonUrl: null },
    shopBotUrl: shops.rows[0]?.username ? `https://t.me/${shops.rows[0].username}` : null,
    groups: groups.rows.map(row => ({ ...row, checkedAt: row.checkedAt?.toISOString() ?? null, nextSendAt: row.nextSendAt?.toISOString() ?? null })),
    campaigns,
  };
}
export async function cancelAdvertisingCampaign(owner: string, id: string, client: AdvertisingClient) {
  const found = await client.query("SELECT id FROM advertising_campaigns WHERE owner_id=$1 AND id=$2", [owner, id]);
  if (!found.rowCount) throw new CommerceError("Campaign not found.", 404);
  await client.query("UPDATE advertising_deliveries SET status='cancelled',note='Stopped by the administrator.' WHERE owner_id=$1 AND campaign_id=$2 AND status='pending'", [owner, id]);
  await client.query("UPDATE advertising_deliveries SET status='uncertain',note='Interrupted send; check Telegram before resending.' WHERE owner_id=$1 AND campaign_id=$2 AND status='sending'", [owner, id]);
  await client.query("UPDATE advertising_campaigns SET status='cancelled' WHERE owner_id=$1 AND id=$2 AND status IN ('queued','sending')", [owner, id]);
}
