import { Api, utils } from "telegram";
import { withAdvertisingLock } from "./advertising-store";
import { withAccountDriver } from "./advertising-account-auth";
import type { AccountFactory } from "./advertising-account-driver";
import { definiteDestinationFailure, queueGroupRemoval } from "./advertising-membership-store";
import { safeAccountError } from "./advertising-account-errors";
import { logger } from "./logger";

export type AccountGroupUpdate = { chatId: string; left?: boolean };

/** Ignore message traffic and changes to other participants. */
export function accountGroupUpdate(update: unknown, selfId: string): AccountGroupUpdate | null {
  if (update instanceof Api.UpdateChatDefaultBannedRights &&
    (update.peer instanceof Api.PeerChat || update.peer instanceof Api.PeerChannel))
    return { chatId: utils.getPeerId(update.peer).toString() };
  if (update instanceof Api.UpdateChatParticipants && update.participants instanceof Api.ChatParticipants)
    return { chatId: utils.getPeerId(new Api.PeerChat({ chatId: update.participants.chatId })).toString(),
      left: !update.participants.participants.some(participant => participant.userId.toString() === selfId) };
  if (update instanceof Api.UpdateChannel)
    return { chatId: utils.getPeerId(new Api.PeerChannel({ channelId: update.channelId })).toString() };
  if (update instanceof Api.UpdateChat)
    return { chatId: utils.getPeerId(new Api.PeerChat({ chatId: update.chatId })).toString() };
  if (update instanceof Api.UpdateChannelParticipant && update.userId.toString() === selfId) {
    const p = update.newParticipant;
    return { chatId: utils.getPeerId(new Api.PeerChannel({ channelId: update.channelId })).toString(),
      left: !p || p instanceof Api.ChannelParticipantLeft || (p instanceof Api.ChannelParticipantBanned && Boolean(p.left)) };
  }
  if ((update instanceof Api.UpdateChatParticipant || update instanceof Api.UpdateChatParticipantAdd ||
    update instanceof Api.UpdateChatParticipantDelete) && update.userId.toString() === selfId) {
    return { chatId: utils.getPeerId(new Api.PeerChat({ chatId: update.chatId })).toString(),
      left: update instanceof Api.UpdateChatParticipantDelete ||
        (update instanceof Api.UpdateChatParticipant && !update.newParticipant) };
  }
  return null;
}

const pending = new Map<string, { change: AccountGroupUpdate; timer: ReturnType<typeof setTimeout> }>();
export function queueAccountGroupUpdate(owner: string, accountId: string, generation: number, change: AccountGroupUpdate, factory: AccountFactory) {
  const key = `${owner}:${generation}:${change.chatId}`;
  const existing = pending.get(key);
  if (existing) { existing.change = change; return; }
  if (pending.size >= 1000) return; // Bound event bursts without creating more connections.
  const entry = { change, timer: setTimeout(() => {
    pending.delete(key);
    void applyAccountGroupUpdate(owner, accountId, generation, entry.change, factory)
      .catch(() => logger.warn("Could not refresh a Telegram membership update; no advertisement was sent."));
  }, 100) };
  pending.set(key, entry);
}

export async function applyAccountGroupUpdate(owner: string, accountId: string, generation: number,
  change: AccountGroupUpdate, factory: AccountFactory) {
  await withAdvertisingLock(owner, async client => {
    const account = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
    if (!account || account.account_id !== accountId || account.generation !== generation || account.login_encrypted) return;
    const groups = (await client.query(`SELECT * FROM advertising_groups WHERE owner_id=$1 AND status<>'removed'
      AND (chat_id=$2 OR target=$2)`, [owner, change.chatId])).rows;
    if (!groups.length) return; // Never rediscover or restore removed destinations.
    const remove = async (group: Record<string, any>, absent: boolean, reason: string) => {
      await queueGroupRemoval(owner, client, { ...group, chat_id: change.chatId }, account, reason);
      if (absent) await client.query(`UPDATE advertising_membership_jobs SET status='already_absent',
        note='Telegram confirmed the account left or was removed from this group.',updated_at=now()
        WHERE owner_id=$1 AND group_id=$2 AND action='leave' AND status='pending' AND account_id=$3`,
      [owner, group.id, accountId]);
    };
    // A self-participant update from this account is authoritative and needs no
    // additional leave RPC, which could fail after a kick.
    if (change.left) {
      for (const group of groups) await remove(group, true, "Telegram reported this account left or was kicked.");
      return;
    }
    if (!account.session_encrypted || account.last_error || new Date(account.telegram_wait_until).getTime() > Date.now()) return;
    await withAccountDriver(owner, client, async driver => {
      const me = await driver.me();
      if (me?.id !== accountId) return;
      for (const group of groups) {
        try {
          if (driver.membership) {
            const membership = await driver.membership(change.chatId);
            if (membership.chatId !== change.chatId) continue;
            if (!membership.joined) { await remove(group, true, "Telegram confirmed the account is no longer a member."); continue; }
          }
          const checked = await driver.inspect(change.chatId);
          if (checked.chatId !== change.chatId) continue;
          await client.query(`UPDATE advertising_groups SET chat_id=$3,title=$4,status='ready',account_generation=$5,
            checked_at=now(),note='Telegram change received; membership and posting permissions reverified.'
            WHERE owner_id=$1 AND id=$2 AND status<>'removed'`, [owner, group.id, checked.chatId, checked.title, generation]);
        } catch (error) {
          const safe = safeAccountError(error);
          if (definiteDestinationFailure(safe)) await remove(group, false, safe.message);
          else {
            await client.query(`UPDATE advertising_groups SET status='pending',account_generation=NULL,
              note='Telegram change received; permissions need verification.' WHERE owner_id=$1 AND id=$2 AND status<>'removed'`, [owner, group.id]);
            throw safe;
          }
        }
      }
    }, factory, "check_groups");
  });
}
