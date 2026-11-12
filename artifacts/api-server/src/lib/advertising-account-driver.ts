import { Api, TelegramClient, utils } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import bigInt from "big-integer";
import type { AdvertisingDraft } from "@workspace/api-zod";
import { CommerceError } from "./commerce-providers";
import { validateAdvertisingDraft } from "./advertising-telegram";

export class AccountError extends CommerceError {
  constructor(message: string, public kind = "validation", public waitSeconds = 0) { super(message, kind === "network" ? 502 : 400); }
}
export function safeAccountError(error: unknown): AccountError {
  if (error instanceof AccountError) return error;
  const e = error as { errorMessage?: string; seconds?: number };
  const code = e?.errorMessage ?? "";
  if (/^(FLOOD|SLOWMODE)/.test(code)) return new AccountError("Telegram requested a waiting period. Posting will wait; do not try to bypass this limit.", "rate_limit", Math.max(1, Math.ceil(Number(e.seconds) || 60)));
  if (["PEER_FLOOD", "USER_DEACTIVATED", "USER_DEACTIVATED_BAN", "USER_RESTRICTED"].includes(code))
    return new AccountError("Telegram restricted or disabled this account. Advertising has stopped. Review the notice in Telegram; do not repeatedly log in or try to bypass the restriction.", "restricted");
  if (code === "SESSION_PASSWORD_NEEDED") return new AccountError("Enter your Telegram two-step verification password.", "password");
  if (code === "PASSWORD_HASH_INVALID") return new AccountError("The two-step verification password was not accepted.");
  if (["PHONE_CODE_INVALID", "PHONE_CODE_EMPTY"].includes(code)) return new AccountError("The login code was not accepted. Check the code and try again.");
  if (["PHONE_CODE_EXPIRED", "AUTH_TOKEN_EXPIRED", "AUTH_TOKEN_INVALID"].includes(code)) return new AccountError("This sign-in challenge expired. Cancel it and start again.", "expired");
  if (["API_ID_INVALID", "API_ID_PUBLISHED_FLOOD"].includes(code)) return new AccountError("Telegram rejected these API app credentials. Check your API ID and API hash.");
  if (code === "PHONE_NUMBER_INVALID") return new AccountError("Use your phone number in international +country-code format.");
  if (code === "USER_NOT_PARTICIPANT") return new AccountError("The Telegram account connected in Advertising is not a member of this group. Check that it is the same account you used to join.");
  if (["AUTH_KEY_UNREGISTERED", "AUTH_KEY_DUPLICATED", "SESSION_REVOKED", "SESSION_EXPIRED"].includes(code))
    return new AccountError("Telegram invalidated or revoked this session. Advertising has stopped. Review Telegram Settings → Devices and any security notice before starting another login. Never run the same session on multiple servers.", "auth");
  if (["CHAT_WRITE_FORBIDDEN", "USER_BANNED_IN_CHANNEL", "CHAT_ADMIN_REQUIRED", "CHANNEL_PRIVATE", "USER_NOT_PARTICIPANT", "CHAT_SEND_PLAIN_FORBIDDEN", "CHAT_SEND_MEDIA_FORBIDDEN"].includes(code))
    return new AccountError("This account is not allowed to post this message in the selected group.");
  if (code) return new AccountError("Telegram rejected the request. Check account access, group permissions and the message.");
  return new AccountError("Telegram did not confirm the request. Check the connection before continuing.", "network");
}
async function bounded<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([fn(), new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new AccountError("Telegram did not confirm the request in time.", "network")), 20000); })]);
  } catch (error) { throw safeAccountError(error); }
  finally { if (timer) clearTimeout(timer); }
}
export function accountMessage(draft: AdvertisingDraft) {
  const clean = validateAdvertisingDraft(draft, true);
  const text = clean.text + (clean.buttonUrl ? `\n\n${clean.buttonText}: ${clean.buttonUrl}` : "");
  if (text.length > (clean.imageUrl ? 1024 : 4096)) throw new AccountError("The complete message, including its shop link, exceeds Telegram's text/caption limit.");
  return { ...clean, text };
}
export interface AccountIdentity { id: string; username: string; displayName: string }
export interface AccountGroup { chatId: string; target: string; title: string }
export interface AccountDriver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  session(): string;
  me(): Promise<AccountIdentity | null>;
  sendCode(phone: string): Promise<string>;
  code(phone: string, hash: string, code: string): Promise<void>;
  password(password: string): Promise<void>;
  qr(): Promise<{ authorized: boolean; url?: string; expires?: number }>;
  groups(): Promise<AccountGroup[]>;
  inspect(target: string, draft?: AdvertisingDraft): Promise<AccountGroup>;
  send(chatId: string, draft: AdvertisingDraft, randomId: string): Promise<void>;
  logout(): Promise<void>;
}
export type AccountFactory = (input: { apiId: number; apiHash: string; session?: string }) => AccountDriver;
export const createAccountDriver: AccountFactory = ({ apiId, apiHash, session = "" }) => {
  const store = new StringSession(session);
  const client = new TelegramClient(store, apiId, apiHash, {
    baseLogger: new Logger(LogLevel.NONE), connectionRetries: 1, requestRetries: 1,
    floodSleepThreshold: 0, autoReconnect: false, retryDelay: 500, timeout: 10,
    deviceModel: "Telecart Advertising", appVersion: "1.0",
  });
  let dialogs: Awaited<ReturnType<typeof client.getDialogs>> | null = null;
  let qrAccepted = false;
  let cachedQr: { authorized: false; url: string; expires: number } | undefined;
  client.addEventHandler(update => {
    if (update instanceof Api.UpdateLoginToken) qrAccepted = true;
  });
  const resolvedGroups = new Map<string, Api.Chat | Api.Channel>();
  const joined = async () => {
    if (!dialogs) dialogs = await client.getDialogs({ limit: 1000, ignoreMigrated: true });
    return dialogs.filter(d => d.entity instanceof Api.Chat || d.entity instanceof Api.Channel);
  };
  const inspect = async (target: string, draft?: AdvertisingDraft) => bounded(async () => {
    let entity = resolvedGroups.get(target);
    if (!entity && target.startsWith("@")) {
      // Public username resolution plus GetParticipant is authoritative. The
      // first 1,000 dialogs can omit an older joined group; absence isn't proof.
      const candidate = await client.getEntity(target);
      if (candidate instanceof Api.Chat || candidate instanceof Api.Channel) entity = candidate;
    }
    if (!entity && !target.startsWith("@")) {
      const dialog = (await joined()).find(d => d.id?.toString() === target);
      if (dialog?.entity instanceof Api.Chat || dialog?.entity instanceof Api.Channel) entity = dialog.entity;
    }
    if (!entity) throw new AccountError("Could not resolve this group for the connected Telegram account. Check the account shown in Advertising, or use the group's public @username.");
    if (entity.left || (entity instanceof Api.Chat && entity.deactivated)) throw new AccountError("This account is no longer a member of this group.");
    let admin = entity.creator || Boolean(entity.adminRights);
    let personalBan: Api.ChatBannedRights | undefined;
    if (entity instanceof Api.Channel) {
      const result = await client.invoke(new Api.channels.GetParticipant({ channel: entity, participant: new Api.InputPeerSelf() }));
      const p = result.participant;
      admin = p instanceof Api.ChannelParticipantCreator || p instanceof Api.ChannelParticipantAdmin;
      if (p instanceof Api.ChannelParticipantLeft || (p instanceof Api.ChannelParticipantBanned && p.left))
        throw new AccountError("The account is not a member of this group.");
      if (p instanceof Api.ChannelParticipantBanned) personalBan = p.bannedRights;
      if (entity.broadcast && !(entity.creator || entity.adminRights?.postMessages)) throw new AccountError("This account cannot post in this channel.");
    } else {
      const full = await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
      const me = await client.getMe();
      if (!(full.fullChat instanceof Api.ChatFull)) throw new AccountError("Could not verify group membership.");
      const participants = full.fullChat.participants;
      if (!(participants instanceof Api.ChatParticipants) || !participants.participants.some(p => p.userId.equals(me.id)))
        throw new AccountError("Could not verify that the connected Telegram account is a member of this group.");
    }
    const restrictions = [personalBan, ...(admin ? [] : [entity.defaultBannedRights])];
    const media = draft?.imageUrl;
    if (restrictions.some(r => r?.sendMessages || r?.sendPlain || (media && (r?.sendMedia || r?.sendPhotos || r?.sendGifs))))
      throw new AccountError("This account lacks permission to send this message/media in the group.");
    const chatId = utils.getPeerId(entity).toString();
    resolvedGroups.set(chatId, entity);
    resolvedGroups.set(target, entity);
    return { chatId, target: chatId, title: utils.getDisplayName(entity) || target };
  });
  return {
    connect: () => bounded(async () => { await client.connect(); }),
    disconnect: async () => { await client.disconnect().catch(() => {}); },
    session: () => store.save(),
    me: () => bounded(async () => {
      // checkAuthorization swallows all RPC failures, including security
      // revocations. Only an unauthorised pending key means "not signed in".
      let user;
      try { user = await client.getMe(); }
      catch (error) {
        if ((error as { errorMessage?: string })?.errorMessage === "AUTH_KEY_UNREGISTERED") return null;
        throw error;
      }
      if (!(user instanceof Api.User) || user.bot) throw new AccountError("Sign in with a personal Telegram account, not a bot.");
      return { id: user.id.toString(), username: user.username ?? "", displayName: [user.firstName, user.lastName].filter(Boolean).join(" ").slice(0, 200) };
    }),
    sendCode: phone => bounded(async () => {
      // GramJS counts a Telegram data-centre redirect as an attempt. A single
      // attempt switches DC but never submits SendCode on the destination.
      // Scope extra attempts to login: unconfirmed advertising sends must not retry.
      const attempts = client._requestRetries;
      client._requestRetries = 3;
      try { return (await client.sendCode({ apiId, apiHash }, phone)).phoneCodeHash; }
      finally { client._requestRetries = attempts; }
    }),
    code: (phone, hash, code) => bounded(async () => {
      const result = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: hash, phoneCode: code }));
      if (!(result instanceof Api.auth.Authorization)) throw new AccountError("Use an existing Telegram account. This dashboard does not create Telegram accounts.");
    }),
    password: password => bounded(async () => { await client.signInWithPassword({ apiId, apiHash }, { password: async () => password, onError: error => { throw error; } }); }),
    qr: () => bounded(async () => {
      if (cachedQr && !qrAccepted && cachedQr.expires * 1000 > Date.now()) return cachedQr;
      qrAccepted = false;
      cachedQr = undefined;
      // Like phone login, QR login may redirect to another data centre.
      // Scope retries to authentication, never to advertising sends.
      const attempts = client._requestRetries;
      client._requestRetries = 3;
      try {
        let result = await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }));
        if (result instanceof Api.auth.LoginTokenMigrateTo) {
          await client._switchDC(result.dcId);
          result = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
        }
        if (result instanceof Api.auth.LoginTokenSuccess) return { authorized: true };
        if (result instanceof Api.auth.LoginToken && result.expires * 1000 > Date.now()) {
          cachedQr = { authorized: false, url: `tg://login?token=${result.token.toString("base64url")}`, expires: result.expires };
          return cachedQr;
        }
        throw new AccountError("Telegram returned an expired or unsupported QR challenge. Cancel this attempt before trying again.", "expired");
      } finally {
        client._requestRetries = attempts;
      }
    }),
    groups: () => bounded(async () => (await joined()).map(d => ({ chatId: d.id!.toString(), target: d.id!.toString(), title: d.title ?? d.id!.toString() }))),
    inspect,
    send: (chatId, draft, randomId) => bounded(async () => {
      await inspect(chatId, draft);
      const entity = resolvedGroups.get(chatId)!;
      const message = accountMessage(draft);
      const common = { peer: utils.getInputPeer(entity), message: message.text, randomId: bigInt(randomId) };
      if (message.imageUrl) {
        const gif = new URL(message.imageUrl).pathname.toLowerCase().endsWith(".gif");
        const media = gif ? new Api.InputMediaDocumentExternal({ url: message.imageUrl }) : new Api.InputMediaPhotoExternal({ url: message.imageUrl });
        await client.invoke(new Api.messages.SendMedia({ ...common, media }));
      } else await client.invoke(new Api.messages.SendMessage({ ...common, noWebpage: true }));
    }),
    logout: () => bounded(async () => { await client.invoke(new Api.auth.LogOut()); }),
  };
};
