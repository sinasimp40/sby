import type { AdvertisingClient } from "./advertising-store";

/**
 * Called under the owner lock. Only confirmed departures or proven duplicate
 * aliases may be erased. Never delete the original when removing an alias.
 */
export async function purgeAdvertisingGroup(owner: string, client: AdvertisingClient, id: string,
  options: { duplicateChatId?: string; transaction?: boolean } = {}) {
  const group = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND id=$2", [owner, id])).rows[0];
  if (!group) return false;
  const duplicate = group.status === "duplicate" || Boolean(options.duplicateChatId &&
    (await client.query("SELECT 1 FROM advertising_groups WHERE owner_id=$1 AND id<>$2 AND chat_id=$3",
      [owner, id, options.duplicateChatId])).rowCount);
  if (!duplicate) {
    if (group.status !== "removed" || !group.chat_id) return false;
    const proof = await client.query(`SELECT 1 FROM advertising_membership_jobs j
      JOIN advertising_accounts a ON a.owner_id=j.owner_id AND a.account_id=j.account_id
      WHERE j.owner_id=$1 AND j.group_id=$2 AND j.chat_id=$3 AND j.action='leave'
      AND j.status IN ('left','already_absent')`, [owner, id, group.chat_id]);
    if (!proof.rowCount) return false;
  } else {
    // A duplicate waiting for an in-flight action must not stay enabled.
    await client.query("UPDATE advertising_groups SET status='duplicate',enabled=false,account_generation=NULL WHERE owner_id=$1 AND id=$2", [owner, id]);
    await client.query(`UPDATE advertising_schedules SET running=false,next_send_at=NULL,revision=revision+1,
      note='Duplicate alias excluded; the original group is unchanged.' WHERE owner_id=$1 AND group_id=$2`, [owner, id]);
  }
  // The lock serializes live RPCs. Interrupted sends and membership operations
  // must be reconciled before any identities/evidence disappear.
  if ((await client.query(`SELECT 1 FROM advertising_account_runs WHERE owner_id=$1 AND group_id=$2 AND status='sending'
    UNION ALL SELECT 1 FROM advertising_deliveries WHERE owner_id=$1 AND group_id=$2 AND status='sending'
    UNION ALL SELECT 1 FROM advertising_membership_jobs WHERE owner_id=$1 AND group_id=$2 AND status='working'`,
  [owner, id])).rowCount) return false;
  const transaction = options.transaction !== false;
  if (transaction) await client.query("BEGIN");
  try {
    // Keep only an opaque confirmation hash, not a destination tombstone, so a
    // retried old join request cannot join again after its job was erased.
    const joins = (await client.query(`SELECT DISTINCT request_key,payload_hash FROM advertising_membership_jobs
      WHERE owner_id=$1 AND action='join' AND (group_id=$2 OR (group_id IS NULL AND target=$3))`,
    [owner, id, group.target])).rows;
    for (const join of joins) await client.query(`INSERT INTO advertising_account_commands(owner_id,request_key,payload_hash)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [owner, `membership:${join.request_key}`, join.payload_hash]);
    const checkpoint = (await client.query("SELECT data AS checkpoint_data FROM advertising_checkpoints WHERE owner_id=$1", [owner])).rows[0];
    if (checkpoint) {
      const data = typeof checkpoint.checkpoint_data === "string" ? JSON.parse(checkpoint.checkpoint_data) : checkpoint.checkpoint_data;
      if (Array.isArray(data.queue)) {
        data.queue = data.queue.filter((entry: { groupId: string }) => entry.groupId !== id);
        await client.query(`UPDATE advertising_checkpoints SET data=$2::jsonb,revision=revision+1,updated_at=now() WHERE owner_id=$1`,
          [owner, JSON.stringify(data)]);
      }
    }
    await client.query("DELETE FROM advertising_deliveries WHERE owner_id=$1 AND group_id=$2", [owner, id]);
    await client.query("DELETE FROM advertising_account_runs WHERE owner_id=$1 AND group_id=$2", [owner, id]);
    await client.query("DELETE FROM advertising_schedules WHERE owner_id=$1 AND group_id=$2", [owner, id]);
    await client.query(`DELETE FROM advertising_membership_jobs WHERE owner_id=$1 AND (group_id=$2 OR (group_id IS NULL AND target=$3))`,
      [owner, id, group.target]);
    await client.query("DELETE FROM advertising_groups WHERE owner_id=$1 AND id=$2", [owner, id]);
    if (transaction) await client.query("COMMIT");
    return true;
  } catch (error) {
    if (transaction) await client.query("ROLLBACK");
    throw error;
  }
}

/** Also cleans older confirmed removals and duplicate rows without remote RPCs. */
export async function purgeCompletedGroupRemovals(owner: string, client: AdvertisingClient) {
  const groups = (await client.query("SELECT id FROM advertising_groups WHERE owner_id=$1 AND status IN ('removed','duplicate')", [owner])).rows;
  for (const group of groups) await purgeAdvertisingGroup(owner, client, group.id);
}
