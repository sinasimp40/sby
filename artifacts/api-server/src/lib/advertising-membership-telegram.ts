import { Api, utils, type TelegramClient } from "telegram";
import { AccountError } from "./advertising-account-errors";

export type MembershipProbe = { chatId: string | null; title: string; joined: boolean; approval: boolean };
type Group = Api.Chat | Api.Channel;
const inviteHash = (target: string) => /^https:\/\/t\.me\/\+([A-Za-z0-9_-]+)$/.exec(target)?.[1];
const groupOnly = (entity: unknown): Group => {
  if (entity instanceof Api.ChatForbidden || entity instanceof Api.ChannelForbidden)
    throw new AccountError("Telegram denies access to this saved group.", "permission", 0, "CHANNEL_PRIVATE", true);
  if (!(entity instanceof Api.Chat || entity instanceof Api.Channel)) throw new AccountError("This target is not a group or channel.");
  return entity;
};
const description = (entity: Group, joined: boolean): MembershipProbe => ({
  chatId: utils.getPeerId(entity).toString(), title: entity.title, joined, approval: Boolean(entity instanceof Api.Channel && entity.joinRequest),
});

export async function resolveGroup(client: TelegramClient, target: string): Promise<Group> {
  try { return groupOnly(await client.getEntity(target)); }
  catch (error) {
    // Missing cached access hashes are not transport failures. Refresh only for
    // that specific SDK resolution error; never retry a failed network request.
    const missing = error instanceof Error && /^(Could not find the input entity|Cannot find any entity corresponding|No user has)/.test(error.message);
    if (!missing) throw error;
    if (/^-\d+$/.test(target)) {
      const dialogs = await client.getDialogs({ limit: 1000, ignoreMigrated: false });
      const found = dialogs.find(dialog => (dialog.entity instanceof Api.Channel || dialog.entity instanceof Api.Chat) &&
        utils.getPeerId(dialog.entity).toString() === target);
      if (found?.entity) return groupOnly(found.entity);
    }
    throw new AccountError("Cannot resolve this saved Telegram group. Removed from advertising; leaving requires its verified numeric identity.",
      "destination", 0, "DESTINATION_UNRESOLVED", true);
  }
}

export async function inspectMembership(client: TelegramClient, target: string): Promise<MembershipProbe> {
  const hash = inviteHash(target);
  if (hash) {
    const result = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
    if (result instanceof Api.ChatInviteAlready) return description(groupOnly(result.chat), true);
    if (result instanceof Api.ChatInvite) return { chatId: null, title: result.title, joined: false, approval: Boolean(result.requestNeeded) };
    throw new AccountError("This invitation could not be verified. Open it in Telegram to check.");
  }
  const entity = await resolveGroup(client, target);
  if (entity.left || (entity instanceof Api.Chat && entity.deactivated)) return description(entity, false);
  if (entity instanceof Api.Channel) {
    try {
      const result = await client.invoke(new Api.channels.GetParticipant({ channel: entity, participant: new Api.InputPeerSelf() }));
      return description(entity, !(result.participant instanceof Api.ChannelParticipantLeft ||
        (result.participant instanceof Api.ChannelParticipantBanned && result.participant.left)));
    } catch (error) {
      if ((error as { errorMessage?: string })?.errorMessage === "USER_NOT_PARTICIPANT") return description(entity, false);
      throw error;
    }
  }
  const full = await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
  const me = await client.getMe();
  if (!(full.fullChat instanceof Api.ChatFull) || !(full.fullChat.participants instanceof Api.ChatParticipants))
    throw new AccountError("Could not verify basic-group membership.");
  return description(entity, full.fullChat.participants.participants.some(p => p.userId.equals(me.id)));
}

export async function joinMembership(client: TelegramClient, target: string, expectedChatId: string | null) {
  const before = await inspectMembership(client, target);
  if (expectedChatId !== null && before.chatId !== expectedChatId)
    throw new AccountError("Group identity changed since preview. Preview the file again.");
  if (before.joined) return { ...before, outcome: "already_joined" };
  if (/^-\d+$/.test(target)) throw new AccountError("A chat ID alone cannot join a group. Use a public username or invitation.");
  const hash = inviteHash(target);
  try {
    if (hash) await client.invoke(new Api.messages.ImportChatInvite({ hash }));
    else await client.invoke(new Api.channels.JoinChannel({ channel: await resolveGroup(client, target) }));
  } catch (error) {
    if ((error as { errorMessage?: string })?.errorMessage === "INVITE_REQUEST_SENT")
      return { ...before, outcome: "awaiting_approval" };
    if ((error as { errorMessage?: string })?.errorMessage !== "USER_ALREADY_PARTICIPANT") throw error;
  }
  const after = await inspectMembership(client, target);
  if (after.joined) return { ...after, outcome: "joined" };
  // A successful RPC without confirmed membership is not proof of joining.
  return { ...after, outcome: before.approval ? "awaiting_approval" : "uncertain" };
}

export async function leaveMembership(client: TelegramClient, target: string, expectedChatId: string) {
  // Resolve the pinned numeric ID, never a possibly reassigned public username.
  let entity: Group;
  try { entity = await resolveGroup(client, expectedChatId); }
  catch (error) {
    if (["USER_NOT_PARTICIPANT", "USER_KICKED"].includes((error as { errorMessage?: string })?.errorMessage ?? "")) return "already_absent";
    throw error; // Absence from a bounded dialog list is not proof of leaving.
  }
  if (utils.getPeerId(entity).toString() !== expectedChatId) throw new AccountError("Group identity mismatch. No leave request was sent.");
  if (entity.left || (entity instanceof Api.Chat && entity.deactivated)) return "already_absent";
  try {
    if (entity instanceof Api.Channel) await client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
    else await client.invoke(new Api.messages.DeleteChatUser({ chatId: entity.id, userId: new Api.InputUserSelf(), revokeHistory: false }));
  } catch (error) {
    if (["USER_NOT_PARTICIPANT", "USER_KICKED"].includes((error as { errorMessage?: string })?.errorMessage ?? "")) return "already_absent";
    throw error;
  }
  return "left";
}
