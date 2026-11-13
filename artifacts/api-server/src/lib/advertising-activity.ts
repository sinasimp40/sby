import { pool } from "@workspace/db";
import { CommerceError } from "./commerce-providers";
import { withAdvertisingLock } from "./advertising-store";

const maintenance = new Map<string, number>();
const pending = new Map<string, Promise<void>>();

// Occurrence evidence must not disappear before a sender reconciles it:
// doing so could replay an already-posted message after a long outage.
export async function pruneAdvertisingActivity(owner: string) {
  return withAdvertisingLock(owner, async client => {
    const result = await client.query(`DELETE FROM advertising_account_runs WHERE id IN (
      SELECT r.id FROM advertising_account_runs r
      WHERE r.owner_id=$1 AND COALESCE(r.sent_at,r.started_at) < now()-interval '5 days' AND r.status<>'sending'
      AND NOT EXISTS (SELECT 1 FROM advertising_schedules s WHERE s.owner_id=r.owner_id
        AND s.group_id=r.group_id AND s.revision=r.revision AND s.next_send_at=r.scheduled_for)
      ORDER BY r.started_at LIMIT 1000
    )`, [owner]);
    return result.rowCount ?? 0;
  });
}

export async function maintainAdvertisingActivity(owner: string) {
  const existing = pending.get(owner);
  if (existing) return existing;
  if (Date.now() - (maintenance.get(owner) ?? 0) < 60 * 60 * 1000) return;
  const job = (async () => {
    const removed = await pruneAdvertisingActivity(owner);
    maintenance.set(owner, removed >= 1000 ? 0 : Date.now());
  })();
  pending.set(owner, job);
  try { await job; } finally { pending.delete(owner); }
}

export async function advertisingActivity(owner: string, from?: Date, to?: Date) {
  if (Boolean(from) !== Boolean(to) || (from && to &&
    (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) ||
      to.getTime() <= from.getTime() || to.getTime() - from.getTime() > 26 * 60 * 60 * 1000)))
    throw new CommerceError("Choose one valid calendar date.", 400);
  const rows = (await pool.query(`SELECT id,group_id AS "groupId",target,status,note,
    started_at AS "startedAt",sent_at AS "sentAt" FROM advertising_account_runs
    WHERE owner_id=$1 AND COALESCE(sent_at,started_at)>=now()-interval '5 days'
      AND ($2::timestamptz IS NULL OR COALESCE(sent_at,started_at)>=$2)
      AND ($3::timestamptz IS NULL OR COALESCE(sent_at,started_at)<$3)
    ORDER BY COALESCE(sent_at,started_at) DESC,id DESC LIMIT 10`, [owner, from ?? null, to ?? null])).rows;
  return rows.map(row => ({ ...row, startedAt: row.startedAt.toISOString(), sentAt: row.sentAt?.toISOString() ?? null }));
}
