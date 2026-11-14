import type { AdvertisingClient } from "./advertising-store";

export const MISSING_LEAVE_IDENTITY = "Cannot safely identify this group for leaving. Removed locally; check membership manually.";

/** Recover only the known pre-RPC identity bug, never arbitrary failed leaves. */
export async function repairMissingLeaveIdentities(owner: string, client: AdvertisingClient, account: Record<string, any>) {
  const jobs = (await client.query(`SELECT j.id,j.group_id,j.status,j.chat_id AS job_chat_id,g.chat_id,g.target
    FROM advertising_membership_jobs j JOIN advertising_groups g ON g.id=j.group_id AND g.owner_id=j.owner_id
    WHERE j.owner_id=$1 AND j.account_id=$2 AND j.action='leave' AND j.payload_hash='automatic'
      AND g.status='removed' AND (j.status='pending' OR (j.status='failed' AND j.note=$3))`,
  [owner, account.account_id, MISSING_LEAVE_IDENTITY])).rows;
  for (const job of jobs) {
    const pinned = job.chat_id || (/^-[1-9]\d*$/.test(job.target) ? job.target : null) || job.job_chat_id;
    if (!pinned || (job.job_chat_id && job.job_chat_id !== pinned)) continue;
    if (job.status === "pending" && job.chat_id === pinned && job.job_chat_id === pinned) continue;
    await client.query(`UPDATE advertising_groups SET chat_id=$3 WHERE owner_id=$1 AND id=$2 AND status='removed'`,
      [owner, job.group_id, pinned]);
    await client.query(`UPDATE advertising_membership_jobs SET chat_id=$3,generation=$4,status='pending',
      note='Recovered the saved numeric group identity. Verified account leave queued.',updated_at=now()
      WHERE owner_id=$1 AND id=$2 AND (status='pending' OR (status='failed' AND note=$5))`,
    [owner, job.id, pinned, account.generation, MISSING_LEAVE_IDENTITY]);
  }
}
