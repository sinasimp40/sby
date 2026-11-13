import { pool } from "@workspace/db";
import { CommerceError } from "./commerce-providers";
import { withAdvertisingLock } from "./advertising-store";
import { createHash } from "node:crypto";
import { z } from "zod";

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

const cursorSchema = z.object({
  v: z.literal(1),
  at: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/)
    .refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === `${v.slice(0, 23)}Z`),
  id: z.string().uuid(),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function advertisingActivityPage(owner: string, from?: Date, to?: Date, cursor?: string) {
  if (Boolean(from) !== Boolean(to) || (from && to &&
    (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) ||
      to.getTime() <= from.getTime() || to.getTime() - from.getTime() > 26 * 60 * 60 * 1000)))
    throw new CommerceError("Choose one valid calendar date.", 400);
  const scope = createHash("sha256").update(JSON.stringify([owner, from?.toISOString() ?? null, to?.toISOString() ?? null])).digest("hex");
  let before: z.infer<typeof cursorSchema> | undefined;
  if (cursor !== undefined) {
    try {
      if (!cursor.length || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      before = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      if (before.scope !== scope) throw new Error();
    } catch { throw new CommerceError("This history cursor is invalid for the selected date. Reload the posting list.", 400); }
  }
  const rows = (await pool.query(`SELECT id,group_id AS "groupId",target,status,note,
    started_at AS "startedAt",sent_at AS "sentAt",
    to_char(COALESCE(sent_at,started_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
    FROM advertising_account_runs
    WHERE owner_id=$1 AND COALESCE(sent_at,started_at)>=now()-interval '5 days'
      AND ($2::timestamptz IS NULL OR COALESCE(sent_at,started_at)>=$2)
      AND ($3::timestamptz IS NULL OR COALESCE(sent_at,started_at)<$3)
      AND ($4::timestamptz IS NULL OR (COALESCE(sent_at,started_at),id)<($4::timestamptz,$5::uuid))
    ORDER BY COALESCE(sent_at,started_at) DESC,id DESC LIMIT 11`,
  [owner, from ?? null, to ?? null, before?.at ?? null, before?.id ?? null])).rows;
  const page = rows.slice(0, 10);
  const last = page.at(-1);
  return {
    items: page.map(({ cursorAt: _cursorAt, ...row }) => ({
      ...row, startedAt: row.startedAt.toISOString(), sentAt: row.sentAt?.toISOString() ?? null,
    })),
    // Retain PostgreSQL's microseconds; JS Date alone can skip records on a page boundary.
    nextCursor: rows.length > 10 && last
      ? Buffer.from(JSON.stringify({ v: 1, at: last.cursorAt, id: last.id, scope })).toString("base64url") : null,
  };
}

// Workspace consumers keep their original latest-ten array response.
export async function advertisingActivity(owner: string, from?: Date, to?: Date) {
  return (await advertisingActivityPage(owner, from, to)).items;
}
