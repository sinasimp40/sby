import { z } from "zod";
import { pool } from "@workspace/db";
import type { AdvertisingForwardSnapshot, AdvertisingResume } from "@workspace/api-zod";
import type { AdvertisingClient } from "./advertising-store";
import { validateForwardSnapshot } from "./advertising-saved-messages";

const entrySchema = z.object({
  groupId: z.string().uuid(), chatId: z.string(), order: z.number().int().min(0).max(499),
  nextSendAt: z.string().datetime(), eligible: z.boolean(), held: z.boolean(),
});
const dataSchema = z.object({
  forward: z.unknown(), queue: z.array(entrySchema).max(500),
  groupsSentInInterval: z.number().int().min(0).max(499),
  lastForwardOrder: z.number().int().min(-1).max(499), nextSendAt: z.string().datetime(),
});
export type CheckpointData = Omit<z.infer<typeof dataSchema>, "forward"> & { forward: AdvertisingForwardSnapshot };
export type Checkpoint = { plan_id: string; account_id: string; revision: number; state: string; data: CheckpointData };

export async function readCheckpoint(owner: string, client: Pick<AdvertisingClient, "query"> = pool): Promise<Checkpoint | null> {
  // The legacy SQLite adapter decodes the generic column name "state" as
  // JSON. Alias our plain-text state and explicitly decode checkpoint data.
  const row = (await client.query(`SELECT plan_id,account_id,revision,state AS checkpoint_status,data AS checkpoint_data
    FROM advertising_checkpoints WHERE owner_id=$1`, [owner])).rows[0];
  if (!row) return null;
  const parsed = dataSchema.parse(typeof row.checkpoint_data === "string" ? JSON.parse(row.checkpoint_data) : row.checkpoint_data);
  return { ...row, state: row.checkpoint_status, data: { ...parsed, forward: validateForwardSnapshot(parsed.forward) } };
}

// Called inside the existing owner lock and, for successful sends, the receipt
// transaction. Capture BEFORE Stop clears schedule priorities.
export async function captureCheckpoint(owner: string, client: AdvertisingClient, stoppingIds?: string[] | "all", excludeIds: string[] = []) {
  const master = (await client.query("SELECT draft FROM advertising_bots WHERE owner_id=$1", [owner])).rows[0]?.draft;
  if (!master?.forward) return;
  const forward = validateForwardSnapshot(master.forward);
  const previous = await readCheckpoint(owner, client);
  const same = previous?.plan_id === forward.planId ? previous : null;
  const account = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
  if (!account) return;
  const rows = (await client.query(`SELECT s.*,g.chat_id,g.enabled,g.status FROM advertising_schedules s
    JOIN advertising_groups g ON g.id=s.group_id AND g.owner_id=s.owner_id
    WHERE s.owner_id=$1 AND s.draft->'forward'->>'planId'=$2`, [owner, forward.planId])).rows;
  // Old stopped schedules have already lost their queue priorities. Never
  // fabricate resume progress or make an imported stopped campaign resumable.
  if (!same && !rows.some(row => row.running)) return;
  const uncertain = new Set((await client.query(`SELECT DISTINCT group_id FROM advertising_account_runs WHERE owner_id=$1
    AND status IN ('sending','uncertain') AND draft->'forward'->>'planId'=$2`, [owner, forward.planId])).rows.map(row => row.group_id));
  const queue = rows.map(row => {
    const prior = same?.data.queue.find(entry => entry.groupId === row.group_id);
    return {
      groupId: row.group_id as string, chatId: prior?.chatId ?? row.chat_id as string,
      order: prior?.order ?? Number(row.draft.forward.order),
      nextSendAt: row.next_send_at?.toISOString() ?? prior?.nextSendAt,
      eligible: !excludeIds.includes(row.group_id) && (prior?.eligible ?? Boolean(row.running)),
      held: Boolean(prior?.held || uncertain.has(row.group_id)),
    };
  }).filter(entry => entry.chatId && entry.nextSendAt);
  const active = rows.some(row => row.running && stoppingIds !== "all" && !stoppingIds?.includes(row.group_id));
  const data = dataSchema.parse({
    forward: same?.data.forward ?? forward, queue,
    groupsSentInInterval: account.groups_sent_in_interval,
    lastForwardOrder: account.last_forward_order,
    nextSendAt: account.next_send_at.toISOString(),
  });
  await client.query(`INSERT INTO advertising_checkpoints(owner_id,plan_id,account_id,state,data)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(owner_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,account_id=EXCLUDED.account_id,
    state=EXCLUDED.state,data=EXCLUDED.data,revision=advertising_checkpoints.revision+1,updated_at=now()`,
  [owner, forward.planId, forward.source.accountId, active ? "active" : "paused", JSON.stringify(data)]);
}

export async function resumeSummary(owner: string): Promise<AdvertisingResume> {
  const empty: AdvertisingResume = { available: false, planId: null, revision: 0, accountId: null,
    groupIds: [], heldGroupIds: [], nextGroupId: null, nextSendAt: null, groupsSentInInterval: 0,
    intervalSeconds: 1800, groupsPerInterval: 1, reason: "No saved checkpoint. Start a new campaign once to enable future resumes." };
  const cp = await readCheckpoint(owner);
  if (!cp) return empty;
  const [account, master, groups] = await Promise.all([
    pool.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner]),
    pool.query("SELECT draft FROM advertising_bots WHERE owner_id=$1", [owner]),
    pool.query("SELECT * FROM advertising_groups WHERE owner_id=$1", [owner]),
  ]);
  const current = account.rows[0];
  const eligible = cp.data.queue.filter(entry => entry.eligible && !entry.held && groups.rows.some(group =>
    group.id === entry.groupId && group.chat_id === entry.chatId && group.enabled && ["ready", "pending"].includes(group.status)));
  const sorted = [...eligible].sort((a, b) => a.nextSendAt.localeCompare(b.nextSendAt) || a.order - b.order);
  const reason = master.rows[0]?.draft?.forward?.planId !== cp.plan_id ? "The selected campaign changed. Start a new campaign." :
    cp.state !== "paused" ? "Campaign is already running." :
    current?.account_id !== cp.account_id ? "Sign in with the original Telegram account to resume." :
    !current.session_encrypted || current.last_error || current.login_encrypted ? "Verify the account connection before resuming." :
    !eligible.length ? "No eligible groups remain. UNCERTAIN groups are excluded and queued for removal/leaving; disabled or removed groups are excluded." : "";
  const gate = Math.max(Date.parse(cp.data.nextSendAt), new Date(current?.telegram_wait_until ?? 0).getTime());
  return { available: !reason, planId: cp.plan_id, revision: cp.revision, accountId: cp.account_id,
    groupIds: eligible.sort((a, b) => a.order - b.order).map(entry => entry.groupId),
    heldGroupIds: cp.data.queue.filter(entry => entry.held).map(entry => entry.groupId),
    nextGroupId: sorted[0]?.groupId ?? null, nextSendAt: new Date(gate).toISOString(),
    groupsSentInInterval: cp.data.groupsSentInInterval, intervalSeconds: cp.data.forward.intervalSeconds,
    groupsPerInterval: cp.data.forward.groupsPerInterval ?? 1, reason };
}

export async function checkpointAllowsVerification(owner: string, client: AdvertisingClient, planId: string, groupId: string, chatId: string, accountId: string) {
  const cp = await readCheckpoint(owner, client);
  return cp?.state === "active" && cp.plan_id === planId && cp.account_id === accountId &&
    cp.data.queue.some(entry => entry.groupId === groupId && entry.chatId === chatId && entry.eligible && !entry.held);
}
